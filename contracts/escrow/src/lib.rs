//! Escrow Contract
//!
//! Holds funds in escrow for a job between a client and freelancer.
//! Supports milestone-based releases and integrates with the dispute contract.
//!
//! # State Machine
//!
//!   Created → Active → Completed
//!                  ↘ Disputed → Completed (via dispute contract)
//!                  ↘ Refunded (via reclaim_expired)
//!
//! # Contributor Notes
//! - All token transfers use the Stellar Asset Contract (SAC) interface.
//! - Checks-Effects-Interactions pattern is preserved in every state transition:
//!   storage is updated *before* any token transfer.
//! - `resolve` is callable only by the dispute contract registered in `init`.
//! - Persistent and instance storage entries are TTL-extended on every mutation
//!   and on reads, so live escrows do not fall out of the ledger.
//! - Errors are returned as [`EscrowError`]; no `assert!`/`unwrap` in production paths.

#![no_std]

use soroban_sdk::{contract, contractevent, contractimpl, contracttype, token, Address, Env, Vec};

// Shared with the dispute and reputation contracts via the `interface` crate.
pub use interface::{EscrowData, EscrowError, EscrowStatus, Milestone};

// ---------------------------------------------------------------------------
// TTL constants (in ledgers; ~5s per ledger)
// ---------------------------------------------------------------------------

/// Approximate number of ledgers in a day (24h * 60m * 60s / 5s).
const DAY_IN_LEDGERS: u32 = 17_280;
/// Extend a storage entry when its remaining TTL drops below this.
const TTL_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
/// Extend a storage entry out to this many ledgers from now.
const TTL_EXTEND_TO: u32 = 90 * DAY_IN_LEDGERS;
/// Default seconds after a dispute is opened before the client can reclaim.
const DEFAULT_DISPUTE_TIMEOUT_SECONDS: u64 = 7 * 24 * 60 * 60;
/// Maximum number of milestones per escrow. Keeps every loop within the
/// Soroban CPU budget and prevents `resolve`/`remaining` from being blocked
/// by an unbounded list. Must match the cap enforced by the frontend.
pub const MAX_MILESTONES: u32 = 20;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[contracttype]
pub enum DataKey {
    Escrow(u64),
    Counter,
    Admin,
    DisputeContract,
    DisputeTimeoutSeconds,
    /// Timestamp after which a `Disputed` escrow may be reclaimed by the client.
    DisputeDeadline(u64),
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Created {
    #[topic]
    pub client: Address,
    pub escrow_id: u64,
    pub freelancer: Address,
    pub total_amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Funded {
    #[topic]
    pub client: Address,
    pub escrow_id: u64,
    pub amount: i128,
    pub freelancer: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneReleased {
    #[topic]
    pub escrow_id: u64,
    pub index: u32,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeOpened {
    #[topic]
    pub escrow_id: u64,
    pub initiator: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Resolved {
    #[topic]
    pub escrow_id: u64,
    pub client_share: i128,
    pub freelancer_share: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Refunded {
    #[topic]
    pub escrow_id: u64,
    pub client: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestonesUpdated {
    #[topic]
    pub escrow_id: u64,
    pub count: u32,
    pub total_amount: i128,
}

/// Admin rotation of the dispute contract — the address authorised to call
/// [`resolve`](EscrowContract::resolve). Emitted so a change of fund-motion
/// authority is observable on-chain (see `docs/EVENTS.md`).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeContractUpdated {
    #[topic]
    pub admin: Address,
    pub old_contract: Address,
    pub new_contract: Address,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// One-time initialization.
    ///
    /// - `admin`            – address allowed to rotate the dispute contract.
    /// - `dispute_contract` – the only address permitted to call [`resolve`].
    pub fn init(env: Env, admin: Address, dispute_contract: Address) -> Result<(), EscrowError> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::DisputeContract, &dispute_contract);
        env.storage().instance().set(
            &DataKey::DisputeTimeoutSeconds,
            &DEFAULT_DISPUTE_TIMEOUT_SECONDS,
        );
        Self::extend_instance(&env);
        Ok(())
    }

    /// Set the dispute timeout in seconds. Admin only; the value must be positive.
    pub fn set_dispute_timeout(env: Env, timeout_seconds: u64) -> Result<(), EscrowError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(EscrowError::NotInitialized)?;
        admin.require_auth();
        if timeout_seconds == 0 {
            return Err(EscrowError::InvalidDisputeTimeout);
        }
        env.storage()
            .instance()
            .set(&DataKey::DisputeTimeoutSeconds, &timeout_seconds);
        Self::extend_instance(&env);
        Ok(())
    }

    /// Rotate the dispute contract. Admin only.
    pub fn set_dispute_contract(env: Env, dispute_contract: Address) -> Result<(), EscrowError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(EscrowError::NotInitialized)?;
        admin.require_auth();
        let old_contract: Address = env
            .storage()
            .instance()
            .get(&DataKey::DisputeContract)
            .ok_or(EscrowError::NotInitialized)?;
        env.storage()
            .instance()
            .set(&DataKey::DisputeContract, &dispute_contract);
        Self::extend_instance(&env);

        DisputeContractUpdated {
            admin,
            old_contract,
            new_contract: dispute_contract,
        }
        .publish(&env);
        Ok(())
    }

    /// Create a new escrow job.
    ///
    /// # Arguments
    /// - `client`     – party funding the job
    /// - `freelancer` – party delivering the work
    /// - `token`      – SAC-compatible token address (e.g. USDC)
    /// - `milestones` – ordered list of milestones; each amount must be > 0
    /// - `expiry`     – unix timestamp safety deadline, must be in the future
    ///
    /// Returns the new escrow ID.
    pub fn create(
        env: Env,
        client: Address,
        freelancer: Address,
        token: Address,
        milestones: Vec<Milestone>,
        expiry: u64,
    ) -> Result<u64, EscrowError> {
        client.require_auth();

        if milestones.is_empty() {
            return Err(EscrowError::InvalidMilestones);
        }
        if milestones.len() > MAX_MILESTONES {
            return Err(EscrowError::TooManyMilestones);
        }
        if client == freelancer {
            return Err(EscrowError::InvalidCounterparty);
        }
        if expiry <= env.ledger().timestamp() {
            return Err(EscrowError::InvalidExpiry);
        }

        let mut total_amount: i128 = 0;
        for m in milestones.iter() {
            if m.amount <= 0 {
                return Err(EscrowError::ZeroAmount);
            }
            total_amount = total_amount
                .checked_add(m.amount)
                .ok_or(EscrowError::Overflow)?;
        }

        let id = Self::next_id(&env)?;
        let escrow = EscrowData {
            client,
            freelancer,
            token,
            total_amount,
            milestones,
            status: EscrowStatus::Created,
            created_at: env.ledger().timestamp(),
            expiry,
        };
        Self::save(&env, id, &escrow);

        Created {
            client: escrow.client.clone(),
            escrow_id: id,
            freelancer: escrow.freelancer.clone(),
            total_amount: escrow.total_amount,
        }
        .publish(&env);
        Ok(id)
    }

    /// Replace the milestone breakdown while the escrow is still unfunded.
    ///
    /// Only allowed in `Created` state (before any money moves) and only for the
    /// client. Re-runs the same validation as [`create`] and recomputes the
    /// stored `total_amount`.
    pub fn update_milestones(
        env: Env,
        escrow_id: u64,
        milestones: Vec<Milestone>,
    ) -> Result<(), EscrowError> {
        let mut escrow = Self::load(&env, escrow_id)?;
        escrow.client.require_auth();

        // Funds are already committed once the escrow is Active.
        if escrow.status != EscrowStatus::Created {
            return Err(EscrowError::InvalidStatus);
        }
        if milestones.is_empty() {
            return Err(EscrowError::InvalidMilestones);
        }
        if milestones.len() > MAX_MILESTONES {
            return Err(EscrowError::TooManyMilestones);
        }

        let mut total_amount: i128 = 0;
        for m in milestones.iter() {
            if m.amount <= 0 {
                return Err(EscrowError::ZeroAmount);
            }
            total_amount = total_amount
                .checked_add(m.amount)
                .ok_or(EscrowError::Overflow)?;
        }

        let count = milestones.len();
        escrow.milestones = milestones;
        escrow.total_amount = total_amount;
        Self::save(&env, escrow_id, &escrow);

        MilestonesUpdated {
            escrow_id,
            count,
            total_amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Client deposits funds, moving escrow from Created to Active.
    pub fn fund(env: Env, escrow_id: u64) -> Result<(), EscrowError> {
        let mut escrow = Self::load(&env, escrow_id)?;
        escrow.client.require_auth();

        if escrow.status != EscrowStatus::Created {
            return Err(EscrowError::InvalidStatus);
        }

        // Effects before interaction.
        escrow.status = EscrowStatus::Active;
        Self::save(&env, escrow_id, &escrow);

        // Interaction: move the full amount into this contract.
        let contract = env.current_contract_address();
        token::Client::new(&env, &escrow.token).transfer(
            &escrow.client,
            &contract,
            &escrow.total_amount,
        );

        Funded {
            client: escrow.client.clone(),
            escrow_id,
            amount: escrow.total_amount,
            freelancer: escrow.freelancer.clone(),
        }
        .publish(&env);
        Ok(())
    }

    /// Client approves release of a specific milestone to the freelancer.
    pub fn release_milestone(
        env: Env,
        escrow_id: u64,
        milestone_index: u32,
    ) -> Result<(), EscrowError> {
        let mut escrow = Self::load(&env, escrow_id)?;
        escrow.client.require_auth();

        if escrow.status != EscrowStatus::Active {
            return Err(EscrowError::InvalidStatus);
        }
        if milestone_index >= escrow.milestones.len() {
            return Err(EscrowError::MilestoneIndexOutOfBounds);
        }

        let mut milestone = escrow
            .milestones
            .get(milestone_index)
            .ok_or(EscrowError::MilestoneIndexOutOfBounds)?;
        if milestone.released {
            return Err(EscrowError::MilestoneAlreadyReleased);
        }

        // Release whatever is still outstanding on this milestone.
        let amount = milestone
            .amount
            .checked_sub(milestone.released_amount)
            .ok_or(EscrowError::Overflow)?;

        // Effects before interaction.
        milestone.released_amount = milestone.amount;
        milestone.released = true;
        escrow.milestones.set(milestone_index, milestone.clone());

        let all_done = escrow.milestones.iter().all(|m| m.released);
        if all_done {
            escrow.status = EscrowStatus::Completed;
        }
        Self::save(&env, escrow_id, &escrow);

        // Interaction: pay freelancer the remaining amount.
        let contract = env.current_contract_address();
        token::Client::new(&env, &escrow.token).transfer(&contract, &escrow.freelancer, &amount);

        MilestoneReleased {
            escrow_id,
            index: milestone_index,
            amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Release part of a milestone to the freelancer.
    ///
    /// Mirrors [`release_milestone`] (client auth, `Active` only) but pays only
    /// `amount`. The milestone is marked released once its full amount has been
    /// paid; the escrow completes when every milestone is released.
    pub fn release_partial(
        env: Env,
        escrow_id: u64,
        milestone_index: u32,
        amount: i128,
    ) -> Result<(), EscrowError> {
        let mut escrow = Self::load(&env, escrow_id)?;
        escrow.client.require_auth();

        if escrow.status != EscrowStatus::Active {
            return Err(EscrowError::InvalidStatus);
        }
        if milestone_index >= escrow.milestones.len() {
            return Err(EscrowError::MilestoneIndexOutOfBounds);
        }
        if amount <= 0 {
            return Err(EscrowError::ZeroAmount);
        }

        let mut milestone = escrow
            .milestones
            .get(milestone_index)
            .ok_or(EscrowError::MilestoneIndexOutOfBounds)?;
        if milestone.released {
            return Err(EscrowError::MilestoneAlreadyReleased);
        }

        let remaining_on_milestone = milestone
            .amount
            .checked_sub(milestone.released_amount)
            .ok_or(EscrowError::Overflow)?;
        if amount > remaining_on_milestone {
            return Err(EscrowError::AmountExceedsMilestone);
        }

        // Effects before interaction.
        milestone.released_amount = milestone
            .released_amount
            .checked_add(amount)
            .ok_or(EscrowError::Overflow)?;
        if milestone.released_amount == milestone.amount {
            milestone.released = true;
        }
        escrow.milestones.set(milestone_index, milestone);

        let all_done = escrow.milestones.iter().all(|m| m.released);
        if all_done {
            escrow.status = EscrowStatus::Completed;
        }
        Self::save(&env, escrow_id, &escrow);

        // Interaction: pay the freelancer.
        let contract = env.current_contract_address();
        token::Client::new(&env, &escrow.token).transfer(&contract, &escrow.freelancer, &amount);

        MilestoneReleased {
            escrow_id,
            index: milestone_index,
            amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Either party can open a dispute, freezing the escrow.
    /// Resolution is handled by the dispute contract registered in `init`.
    pub fn open_dispute(env: Env, escrow_id: u64, initiator: Address) -> Result<(), EscrowError> {
        let mut escrow = Self::load(&env, escrow_id)?;
        initiator.require_auth();

        if escrow.status != EscrowStatus::Active {
            return Err(EscrowError::InvalidStatus);
        }
        if initiator != escrow.client && initiator != escrow.freelancer {
            return Err(EscrowError::Unauthorized);
        }

        escrow.status = EscrowStatus::Disputed;
        Self::save(&env, escrow_id, &escrow);

        // Timelock: if the panel never rules, the client can reclaim after this.
        // The fallback preserves the default for instances initialized before
        // this setting was added.
        let timeout_seconds: u64 = env
            .storage()
            .instance()
            .get(&DataKey::DisputeTimeoutSeconds)
            .unwrap_or(DEFAULT_DISPUTE_TIMEOUT_SECONDS);
        let deadline = env
            .ledger()
            .timestamp()
            .checked_add(timeout_seconds)
            .ok_or(EscrowError::Overflow)?;
        let deadline_key = DataKey::DisputeDeadline(escrow_id);
        env.storage().persistent().set(&deadline_key, &deadline);
        env.storage()
            .persistent()
            .extend_ttl(&deadline_key, TTL_THRESHOLD, TTL_EXTEND_TO);

        DisputeOpened {
            escrow_id,
            initiator,
        }
        .publish(&env);
        Ok(())
    }

    /// Refund the client from a `Disputed` escrow once the dispute timelock has
    /// passed with no ruling. Only unreleased milestones are refunded.
    ///
    /// This is an escape hatch for an unavailable or malicious panel. Since it
    /// moves the escrow to `Refunded`, a late `resolve` is rejected (status is no
    /// longer `Disputed`), so funds cannot be paid out twice.
    pub fn reclaim_after_dispute_timeout(env: Env, escrow_id: u64) -> Result<(), EscrowError> {
        let mut escrow = Self::load(&env, escrow_id)?;
        escrow.client.require_auth();

        if escrow.status != EscrowStatus::Disputed {
            return Err(EscrowError::InvalidStatus);
        }

        let deadline: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::DisputeDeadline(escrow_id))
            .ok_or(EscrowError::NotInitialized)?;
        if env.ledger().timestamp() <= deadline {
            return Err(EscrowError::DisputeTimeoutNotReached);
        }

        let unreleased = Self::remaining(&escrow)?;

        // Effects before interaction.
        escrow.status = EscrowStatus::Refunded;
        Self::save(&env, escrow_id, &escrow);

        if unreleased > 0 {
            let contract = env.current_contract_address();
            token::Client::new(&env, &escrow.token).transfer(
                &contract,
                &escrow.client,
                &unreleased,
            );
        }

        Refunded {
            escrow_id,
            client: escrow.client.clone(),
            amount: unreleased,
        }
        .publish(&env);
        Ok(())
    }

    /// Called by the dispute contract to distribute the frozen funds.
    ///
    /// Both shares must be non-negative and sum exactly to the amount still held
    /// in escrow (the sum of unreleased milestones); otherwise the call fails with
    /// [`EscrowError::InvalidShares`]. This prevents both over-payment and funds
    /// being stranded in the contract.
    pub fn resolve(
        env: Env,
        escrow_id: u64,
        client_share: i128,
        freelancer_share: i128,
    ) -> Result<(), EscrowError> {
        // Only the registered dispute contract may resolve.
        let dispute_contract: Address = env
            .storage()
            .instance()
            .get(&DataKey::DisputeContract)
            .ok_or(EscrowError::NotInitialized)?;
        dispute_contract.require_auth();

        let mut escrow = Self::load(&env, escrow_id)?;
        if escrow.status != EscrowStatus::Disputed {
            return Err(EscrowError::InvalidStatus);
        }
        if client_share < 0 || freelancer_share < 0 {
            return Err(EscrowError::InvalidShares);
        }

        let remaining = Self::remaining(&escrow)?;
        let total_share = client_share
            .checked_add(freelancer_share)
            .ok_or(EscrowError::Overflow)?;
        if total_share != remaining {
            return Err(EscrowError::InvalidShares);
        }

        // Effects before interaction: mark every milestone fully released and complete.
        for i in 0..escrow.milestones.len() {
            let mut m = escrow
                .milestones
                .get(i)
                .ok_or(EscrowError::MilestoneIndexOutOfBounds)?;
            m.released = true;
            m.released_amount = m.amount;
            escrow.milestones.set(i, m);
        }
        escrow.status = EscrowStatus::Completed;
        Self::save(&env, escrow_id, &escrow);

        // Interaction: distribute.
        let token = token::Client::new(&env, &escrow.token);
        let contract = env.current_contract_address();
        if client_share > 0 {
            token.transfer(&contract, &escrow.client, &client_share);
        }
        if freelancer_share > 0 {
            token.transfer(&contract, &escrow.freelancer, &freelancer_share);
        }

        Resolved {
            escrow_id,
            client_share,
            freelancer_share,
        }
        .publish(&env);
        Ok(())
    }

    /// Refund the client if the escrow has passed its safety expiry with no
    /// completion. Only unreleased milestones are refunded.
    pub fn reclaim_expired(env: Env, escrow_id: u64) -> Result<(), EscrowError> {
        let mut escrow = Self::load(&env, escrow_id)?;
        escrow.client.require_auth();

        if escrow.status != EscrowStatus::Active {
            return Err(EscrowError::InvalidStatus);
        }
        if env.ledger().timestamp() <= escrow.expiry {
            return Err(EscrowError::NotExpired);
        }

        let unreleased = Self::remaining(&escrow)?;

        // Effects before interaction.
        escrow.status = EscrowStatus::Refunded;
        Self::save(&env, escrow_id, &escrow);

        if unreleased > 0 {
            let contract = env.current_contract_address();
            token::Client::new(&env, &escrow.token).transfer(
                &contract,
                &escrow.client,
                &unreleased,
            );
        }

        Refunded {
            escrow_id,
            client: escrow.client.clone(),
            amount: unreleased,
        }
        .publish(&env);
        Ok(())
    }

    /// Read escrow state (view).
    pub fn get(env: Env, escrow_id: u64) -> Result<EscrowData, EscrowError> {
        Self::load(&env, escrow_id)
    }

    /// Read the dispute timelock deadline for an escrow (view).
    pub fn dispute_deadline(env: Env, escrow_id: u64) -> Result<u64, EscrowError> {
        env.storage()
            .persistent()
            .get(&DataKey::DisputeDeadline(escrow_id))
            .ok_or(EscrowError::NotFound)
    }

    /// Read the configured dispute contract (view).
    pub fn dispute_contract(env: Env) -> Result<Address, EscrowError> {
        env.storage()
            .instance()
            .get(&DataKey::DisputeContract)
            .ok_or(EscrowError::NotInitialized)
    }

    /// Read the configured dispute timeout in seconds (view).
    pub fn dispute_timeout_seconds(env: Env) -> Result<u64, EscrowError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::NotInitialized);
        }
        Ok(env
            .storage()
            .instance()
            .get(&DataKey::DisputeTimeoutSeconds)
            .unwrap_or(DEFAULT_DISPUTE_TIMEOUT_SECONDS))
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /// Sum of amounts still unpaid across all milestones (funds still held).
    fn remaining(escrow: &EscrowData) -> Result<i128, EscrowError> {
        let mut total: i128 = 0;
        for m in escrow.milestones.iter() {
            let unpaid = m
                .amount
                .checked_sub(m.released_amount)
                .ok_or(EscrowError::Overflow)?;
            total = total.checked_add(unpaid).ok_or(EscrowError::Overflow)?;
        }
        Ok(total)
    }

    fn load(env: &Env, id: u64) -> Result<EscrowData, EscrowError> {
        let escrow: EscrowData = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow(id))
            .ok_or(EscrowError::NotFound)?;
        // Keep live escrows from expiring when they are read.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Escrow(id), TTL_THRESHOLD, TTL_EXTEND_TO);
        Ok(escrow)
    }

    fn save(env: &Env, id: u64, escrow: &EscrowData) {
        let key = DataKey::Escrow(id);
        env.storage().persistent().set(&key, escrow);
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

    fn next_id(env: &Env) -> Result<u64, EscrowError> {
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Counter)
            .unwrap_or(0u64);
        let next = id.checked_add(1).ok_or(EscrowError::Overflow)?;
        env.storage().instance().set(&DataKey::Counter, &next);
        Ok(id)
    }
}

#[cfg(test)]
mod test;
