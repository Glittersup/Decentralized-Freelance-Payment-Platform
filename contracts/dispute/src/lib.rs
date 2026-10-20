//! Dispute Contract
//!
//! Manages dispute resolution for frozen escrows.
//!
//! # Resolution Flow
//!
//!   escrow.open_dispute() → dispute.raise() → dispute.approve()* → dispute.arbitrate()
//!                                              → escrow.resolve()
//!
//! # Contributor Notes
//! - A panel of arbitrators is set once via `init`; every member must authorize
//!   `init`, so the role cannot be sniped by a front-runner. Resolutions need
//!   `threshold`-of-`panel` approvals.
//! - Each `approve` records an arbitrator's signature for a specific split
//!   `(client_share, freelancer_share)`. `arbitrate` only proceeds once enough
//!   panel members approved *that same split*, then cross-calls
//!   `escrow.resolve()`.
//! - `raise` cross-checks the escrow contract: the escrow must be in `Disputed`
//!   state and the initiator must be a participant.
//! - The duplicate guard and `dispute_for` are scoped to
//!   `(escrow_contract, escrow_id)`, so the same escrow id on a different escrow
//!   contract (a redeploy, or a staging instance sharing this dispute contract)
//!   can still raise and look up its own dispute.
//! - `escrow.resolve()` independently validates that the shares sum to the funds
//!   still held, so a bad proposal cannot over- or under-pay.
//! - Escrow has a dispute timelock (`escrow.reclaim_after_dispute_timeout`) as an
//!   escape hatch if the panel never rules; see `docs/DISPUTES.md`.
//!
//! This crate depends on the `escrow` crate for its generated client so the two
//! contracts share one source of truth for the escrow types.

#![no_std]

use interface::{EscrowClient, EscrowData, EscrowStatus};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, String, Vec,
};

// ---------------------------------------------------------------------------
// TTL constants
// ---------------------------------------------------------------------------

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 90 * DAY_IN_LEDGERS;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum DisputeStatus {
    Raised,
    UnderReview,
    Resolved,
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub struct DisputeData {
    pub escrow_id: u64,
    pub escrow_contract: Address,
    pub raised_by: Address,
    pub reason: String,
    pub status: DisputeStatus,
    pub raised_at: u64,
    /// Distribution recorded when the dispute is resolved.
    pub client_share: i128,
    pub freelancer_share: i128,
}

/// A proposed split an arbitrator signs off on.
#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub struct Proposal {
    pub client_share: i128,
    pub freelancer_share: i128,
}

#[contracttype]
pub enum DataKey {
    Dispute(u64),
    Counter,
    Admin,
    /// The arbitrator panel, initially set in `init`.
    Arbitrators,
    /// How many panel approvals a proposal needs (M-of-N).
    Threshold,
    /// Incremented whenever the panel changes, invalidating previous votes.
    PanelVersion,
    /// (dispute_id, panel_version, arbitrator) → the approved split.
    Approval(u64, u32, Address),
    /// (escrow_contract, escrow_id) → dispute_id. Scoped by the escrow contract
    /// so the duplicate guard covers one job, not every job that happens to
    /// share an id: the same `escrow_id` on a different escrow contract (a
    /// redeploy, or a second instance) is an unrelated escrow.
    EscrowDispute(Address, u64),
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Raised {
    #[topic]
    pub escrow_id: u64,
    pub dispute_id: u64,
    pub raised_by: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Approved {
    #[topic]
    pub dispute_id: u64,
    pub arbitrator: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeResolved {
    #[topic]
    pub escrow_id: u64,
    pub dispute_id: u64,
    pub client_share: i128,
    pub freelancer_share: i128,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum DisputeError {
    NotFound = 1,
    AlreadyInitialized = 2,
    NotInitialized = 3,
    InvalidStatus = 4,
    AlreadyRaised = 5,
    EscrowNotFound = 6,
    EscrowNotDisputed = 7,
    Unauthorized = 8,
    EscrowRejected = 9,
    Overflow = 10,
    InvalidPanel = 11,
    InvalidThreshold = 12,
    InsufficientApprovals = 13,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct DisputeContract;

#[contractimpl]
impl DisputeContract {
    /// One-time initialisation: set the admin, arbitrator panel and threshold.
    ///
    /// Every panel member must authorize, so a third party cannot take over the
    /// role by calling `init` first on a freshly deployed contract.
    pub fn init(
        env: Env,
        admin: Address,
        arbitrators: Vec<Address>,
        threshold: u32,
    ) -> Result<(), DisputeError> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Arbitrators) {
            return Err(DisputeError::AlreadyInitialized);
        }
        Self::validate_panel(&env, &arbitrators, threshold)?;
        for arbitrator in arbitrators.iter() {
            if arbitrator != admin {
                arbitrator.require_auth();
            }
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::Arbitrators, &arbitrators);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &threshold);
        env.storage().instance().set(&DataKey::PanelVersion, &0u32);
        Self::extend_instance(&env);
        Ok(())
    }

    /// Replace the arbitrator panel and threshold. Admin and new members must
    /// authorize; all approvals from the previous panel are invalidated.
    pub fn set_panel(
        env: Env,
        arbitrators: Vec<Address>,
        threshold: u32,
    ) -> Result<(), DisputeError> {
        let admin = Self::admin(&env)?;
        admin.require_auth();
        Self::validate_panel(&env, &arbitrators, threshold)?;
        for arbitrator in arbitrators.iter() {
            if arbitrator != admin {
                arbitrator.require_auth();
            }
        }

        let version: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PanelVersion)
            .unwrap_or(0);
        let next_version = version.checked_add(1).ok_or(DisputeError::Overflow)?;
        env.storage()
            .instance()
            .set(&DataKey::Arbitrators, &arbitrators);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &threshold);
        env.storage()
            .instance()
            .set(&DataKey::PanelVersion, &next_version);
        Self::extend_instance(&env);
        Ok(())
    }

    /// Change the approval threshold. Admin only.
    pub fn set_threshold(env: Env, threshold: u32) -> Result<(), DisputeError> {
        let admin = Self::admin(&env)?;
        admin.require_auth();
        let arbitrators: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Arbitrators)
            .ok_or(DisputeError::NotInitialized)?;
        if threshold == 0 || threshold > arbitrators.len() {
            return Err(DisputeError::InvalidThreshold);
        }
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &threshold);
        Self::extend_instance(&env);
        Ok(())
    }

    /// Raise a dispute for a frozen escrow.
    ///
    /// Verifies against the escrow contract that the escrow is `Disputed` and the
    /// caller is a participant. Returns the dispute ID.
    pub fn raise(
        env: Env,
        escrow_id: u64,
        escrow_contract: Address,
        raised_by: Address,
        reason: String,
    ) -> Result<u64, DisputeError> {
        raised_by.require_auth();

        // Scope the duplicate guard by the escrow contract as well as the id.
        // Keying on `escrow_id` alone permanently blocked the same id on any
        // other escrow contract (a redeploy pointed at this dispute contract, or
        // a staging instance) as `AlreadyRaised` — nothing ever clears the key.
        if env
            .storage()
            .persistent()
            .has(&DataKey::EscrowDispute(escrow_contract.clone(), escrow_id))
        {
            return Err(DisputeError::AlreadyRaised);
        }

        // Cross-contract: confirm the escrow is disputed and the caller is a party.
        // `try_*` returns a nested Result: the outer for invocation/conversion
        // failures and the inner for the contract's own Result error.
        let escrow: EscrowData = EscrowClient::new(&env, &escrow_contract)
            .try_get(&escrow_id)
            .map_err(|_| DisputeError::EscrowNotFound)?
            .map_err(|_| DisputeError::EscrowNotFound)?;
        if escrow.status != EscrowStatus::Disputed {
            return Err(DisputeError::EscrowNotDisputed);
        }
        if raised_by != escrow.client && raised_by != escrow.freelancer {
            return Err(DisputeError::Unauthorized);
        }

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Counter)
            .unwrap_or(0u64);
        let next = id.checked_add(1).ok_or(DisputeError::Overflow)?;
        env.storage().instance().set(&DataKey::Counter, &next);

        let dispute = DisputeData {
            escrow_id,
            escrow_contract: escrow_contract.clone(),
            raised_by,
            reason,
            status: DisputeStatus::Raised,
            raised_at: env.ledger().timestamp(),
            client_share: 0,
            freelancer_share: 0,
        };
        Self::save(&env, id, &dispute);
        let escrow_key = DataKey::EscrowDispute(escrow_contract, escrow_id);
        env.storage().persistent().set(&escrow_key, &id);
        env.storage()
            .persistent()
            .extend_ttl(&escrow_key, TTL_THRESHOLD, TTL_EXTEND_TO);

        Raised {
            escrow_id,
            dispute_id: id,
            raised_by: dispute.raised_by.clone(),
        }
        .publish(&env);
        Ok(id)
    }

    /// A panel member approves a specific split for a raised dispute.
    ///
    /// Approvals are per `(dispute_id, arbitrator)` and can be changed by calling
    /// again, so an arbitrator can move their vote.
    pub fn approve(
        env: Env,
        dispute_id: u64,
        arbitrator: Address,
        client_share: i128,
        freelancer_share: i128,
    ) -> Result<(), DisputeError> {
        arbitrator.require_auth();

        let panel: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Arbitrators)
            .ok_or(DisputeError::NotInitialized)?;
        if !panel.iter().any(|a| a == arbitrator) {
            return Err(DisputeError::Unauthorized);
        }
        if client_share < 0 || freelancer_share < 0 {
            return Err(DisputeError::EscrowRejected);
        }
        let panel_version: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PanelVersion)
            .unwrap_or(0);

        let dispute = Self::load(&env, dispute_id)?;
        if dispute.status != DisputeStatus::Raised && dispute.status != DisputeStatus::UnderReview {
            return Err(DisputeError::InvalidStatus);
        }

        let key = DataKey::Approval(dispute_id, panel_version, arbitrator.clone());
        env.storage().persistent().set(
            &key,
            &Proposal {
                client_share,
                freelancer_share,
            },
        );
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);

        Approved {
            dispute_id,
            arbitrator,
        }
        .publish(&env);
        Ok(())
    }

    /// Resolve the dispute once `threshold` panel members have approved the same
    /// split, then trigger fund distribution via `escrow.resolve`.
    ///
    /// # Arguments
    /// - `client_share`     – portion returned to client (0 if a full freelancer win)
    /// - `freelancer_share` – portion paid to freelancer (0 if a full client win)
    pub fn arbitrate(
        env: Env,
        dispute_id: u64,
        client_share: i128,
        freelancer_share: i128,
    ) -> Result<(), DisputeError> {
        let panel: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Arbitrators)
            .ok_or(DisputeError::NotInitialized)?;
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Threshold)
            .ok_or(DisputeError::NotInitialized)?;
        let panel_version: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PanelVersion)
            .unwrap_or(0);

        let mut dispute = Self::load(&env, dispute_id)?;
        if dispute.status != DisputeStatus::Raised && dispute.status != DisputeStatus::UnderReview {
            return Err(DisputeError::InvalidStatus);
        }

        // Count panel approvals that match the proposed split exactly.
        let mut approvals: u32 = 0;
        for arbitrator in panel.iter() {
            let key = DataKey::Approval(dispute_id, panel_version, arbitrator);
            let approval: Option<Proposal> = env.storage().persistent().get(&key);
            if let Some(p) = approval {
                if p.client_share == client_share && p.freelancer_share == freelancer_share {
                    approvals += 1;
                }
            }
        }
        if approvals < threshold {
            return Err(DisputeError::InsufficientApprovals);
        }

        // Effects before interaction.
        dispute.status = DisputeStatus::Resolved;
        dispute.client_share = client_share;
        dispute.freelancer_share = freelancer_share;
        Self::save(&env, dispute_id, &dispute);

        // Interaction: escrow validates the shares sum to the funds it holds.
        EscrowClient::new(&env, &dispute.escrow_contract)
            .try_resolve(&dispute.escrow_id, &client_share, &freelancer_share)
            .map_err(|_| DisputeError::EscrowRejected)?
            .map_err(|_| DisputeError::EscrowRejected)?;

        DisputeResolved {
            escrow_id: dispute.escrow_id,
            dispute_id,
            client_share,
            freelancer_share,
        }
        .publish(&env);
        Ok(())
    }

    /// Read a dispute (view).
    pub fn get(env: Env, dispute_id: u64) -> Result<DisputeData, DisputeError> {
        Self::load(&env, dispute_id)
    }

    /// Read the dispute ID for `escrow_id` on a given escrow contract (view).
    ///
    /// Takes the escrow contract too, so the lookup matches the `(escrow_contract,
    /// escrow_id)` scope of the duplicate guard: the same id on a different
    /// escrow contract is a different dispute.
    pub fn dispute_for(
        env: Env,
        escrow_contract: Address,
        escrow_id: u64,
    ) -> Result<u64, DisputeError> {
        env.storage()
            .persistent()
            .get(&DataKey::EscrowDispute(escrow_contract, escrow_id))
            .ok_or(DisputeError::NotFound)
    }

    /// Read the arbitrator panel (view).
    pub fn arbitrators(env: Env) -> Result<Vec<Address>, DisputeError> {
        env.storage()
            .instance()
            .get(&DataKey::Arbitrators)
            .ok_or(DisputeError::NotInitialized)
    }

    /// Read the approval threshold (view).
    pub fn threshold(env: Env) -> Result<u32, DisputeError> {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .ok_or(DisputeError::NotInitialized)
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    fn admin(env: &Env) -> Result<Address, DisputeError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(DisputeError::NotInitialized)
    }

    fn validate_panel(
        env: &Env,
        arbitrators: &Vec<Address>,
        threshold: u32,
    ) -> Result<(), DisputeError> {
        if arbitrators.is_empty() {
            return Err(DisputeError::InvalidPanel);
        }
        if threshold == 0 || threshold > arbitrators.len() {
            return Err(DisputeError::InvalidThreshold);
        }
        let mut unique = Vec::new(env);
        for arbitrator in arbitrators.iter() {
            if unique.iter().any(|member| member == arbitrator) {
                return Err(DisputeError::InvalidPanel);
            }
            unique.push_back(arbitrator);
        }
        Ok(())
    }

    fn load(env: &Env, id: u64) -> Result<DisputeData, DisputeError> {
        let dispute: DisputeData = env
            .storage()
            .persistent()
            .get(&DataKey::Dispute(id))
            .ok_or(DisputeError::NotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Dispute(id), TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(dispute)
    }

    fn save(env: &Env, id: u64, dispute: &DisputeData) {
        let key = DataKey::Dispute(id);
        env.storage().persistent().set(&key, dispute);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        Self::extend_instance(env);
    }

    fn extend_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

#[cfg(test)]
mod test;
