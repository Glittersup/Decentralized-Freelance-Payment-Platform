//! Reputation Contract
//!
//! Records on-chain ratings after each completed job.
//! Ratings are immutable once submitted and keyed by `(rater, escrow_id)` to
//! prevent duplicates.
//!
//! # Contributor Notes
//! - A rating is only accepted if the escrow contract reports the job as
//!   `Completed` and the rater/ratee are the two participants. This contract
//!   therefore depends on the `escrow` crate for its generated client.
//! - Raw ratings are stored unchanged and remain the source of truth. The
//!   **weighted** aggregate (see `docs/REPUTATION.md`) is *maintained* by
//!   `submit` rather than derived on read:
//!     * each counted rating is weighted by its escrow's `total_amount`,
//!     * only the first rating from a given rater counts (anti-spam),
//!     * `weight` is the sum of weights and `total_score` the weight-summed
//!       score, so `average = total_score / weight`.
//!
//! `submit` already reads the escrow to verify completion, so weighting costs no
//! extra cross-contract call, and `get_aggregate` is a single storage read with
//! none at all (see the cost model in `docs/REPUTATION.md`).
//! - Phase 3 (future work, not yet filed): skill-tag endorsements.

#![no_std]

use interface::{EscrowClient, EscrowData, EscrowStatus};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env,
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
pub struct Rating {
    pub rater: Address,
    pub ratee: Address,
    pub escrow_id: u64,
    pub score: u32, // 1–5
    pub submitted_at: u64,
}

/// Weighted reputation for an address.
///
/// `average = total_score / weight` (0 when `weight` is 0). `count` is the
/// number of ratings that counted toward the aggregate. Maintained by `submit`,
/// so reading it is a single storage read.
#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub struct Aggregate {
    pub total_score: u64,
    pub weight: u64,
    pub count: u64,
}

#[contracttype]
pub enum DataKey {
    /// Keyed by (rater, escrow_id) to prevent duplicate ratings.
    Rating(Address, u64),
    /// Keyed by (ratee, rater). Presence means that rater has already counted
    /// toward the ratee's aggregate, so a later rating from them does not.
    /// This replaces the old per-ratee list of every rating, which grew with
    /// each rating and was deserialized and rewritten in full on every submit.
    RatingCounted(Address, Address),
    /// ratee → the maintained weighted aggregate.
    Aggregate(Address),
    Admin,
    EscrowContract,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rated {
    #[topic]
    pub escrow_id: u64,
    pub rater: Address,
    pub ratee: Address,
    pub score: u32,
    /// The ratee's weighted-aggregate count after this rating is recorded.
    pub count: u64,
    /// The ratee's weighted-aggregate total_score after this rating is recorded.
    pub total_score: u64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ReputationError {
    NotFound = 1,
    AlreadyInitialized = 2,
    NotInitialized = 3,
    InvalidScore = 4,
    AlreadyRated = 5,
    EscrowNotFound = 6,
    EscrowNotCompleted = 7,
    Unauthorized = 8,
    InvalidRatee = 9,
    Overflow = 10,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct ReputationContract;

#[contractimpl]
impl ReputationContract {
    /// One-time initialisation: set the admin and the trusted escrow contract.
    pub fn init(env: Env, admin: Address, escrow_contract: Address) -> Result<(), ReputationError> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ReputationError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::EscrowContract, &escrow_contract);
        Self::extend_instance(&env);
        Ok(())
    }

    /// Change the trusted escrow contract. Admin only.
    pub fn set_escrow_contract(env: Env, escrow_contract: Address) -> Result<(), ReputationError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ReputationError::NotInitialized)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::EscrowContract, &escrow_contract);
        Self::extend_instance(&env);
        Ok(())
    }

    /// Submit a rating after a job completes.
    ///
    /// Verifies with the escrow contract that the job is completed and that the
    /// rater and ratee are its two participants, stores the raw rating as-is,
    /// and folds it into the ratee's aggregate (see [`get_aggregate`]) when it is
    /// the first rating from that rater.
    ///
    /// # Arguments
    /// - `rater`     – address submitting the rating (must be a participant)
    /// - `ratee`     – address being rated (must be the other participant)
    /// - `escrow_id` – completed escrow this rating is for
    /// - `score`     – 1 to 5
    pub fn submit(
        env: Env,
        rater: Address,
        ratee: Address,
        escrow_id: u64,
        score: u32,
    ) -> Result<(), ReputationError> {
        rater.require_auth();

        if !(1..=5).contains(&score) {
            return Err(ReputationError::InvalidScore);
        }

        let escrow_contract: Address = env
            .storage()
            .instance()
            .get(&DataKey::EscrowContract)
            .ok_or(ReputationError::NotInitialized)?;

        // `try_*` returns a nested Result: the outer for invocation/conversion
        // failures and the inner for the contract's own Result error.
        let escrow: EscrowData = EscrowClient::new(&env, &escrow_contract)
            .try_get(&escrow_id)
            .map_err(|_| ReputationError::EscrowNotFound)?
            .map_err(|_| ReputationError::EscrowNotFound)?;
        if escrow.status != EscrowStatus::Completed {
            return Err(ReputationError::EscrowNotCompleted);
        }

        // The rater must be one participant and the ratee the other.
        let expected_ratee = if rater == escrow.client {
            escrow.freelancer.clone()
        } else if rater == escrow.freelancer {
            escrow.client.clone()
        } else {
            return Err(ReputationError::Unauthorized);
        };
        if ratee != expected_ratee {
            return Err(ReputationError::InvalidRatee);
        }

        let key = DataKey::Rating(rater.clone(), escrow_id);
        if env.storage().persistent().has(&key) {
            return Err(ReputationError::AlreadyRated);
        }

        let rating = Rating {
            rater: rater.clone(),
            ratee: ratee.clone(),
            escrow_id,
            score,
            submitted_at: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&key, &rating);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);

        // Fold the rating into the ratee's aggregate, at most once per
        // (ratee, rater): only the first rating from a given rater counts
        // (anti-spam), weighted by the job's `total_amount`. The escrow was
        // already read above to verify completion, so this costs no extra
        // cross-contract call and keeps `get_aggregate` a single storage read.
        let counted_key = DataKey::RatingCounted(ratee.clone(), rater.clone());
        if !env.storage().persistent().has(&counted_key) {
            let weight: u64 = escrow
                .total_amount
                .try_into()
                .map_err(|_| ReputationError::Overflow)?;
            if weight > 0 {
                env.storage().persistent().set(&counted_key, &escrow_id);
                env.storage()
                    .persistent()
                    .extend_ttl(&counted_key, TTL_THRESHOLD, TTL_EXTEND_TO);

                let mut aggregate = Self::get_aggregate(env.clone(), ratee.clone());
                aggregate.total_score = aggregate
                    .total_score
                    .saturating_add((score as u64).saturating_mul(weight));
                aggregate.weight = aggregate.weight.saturating_add(weight);
                aggregate.count = aggregate.count.saturating_add(1);

                let aggregate_key = DataKey::Aggregate(ratee.clone());
                env.storage().persistent().set(&aggregate_key, &aggregate);
                env.storage()
                    .persistent()
                    .extend_ttl(&aggregate_key, TTL_THRESHOLD, TTL_EXTEND_TO);
            }
        }

        Self::extend_instance(&env);

        let aggregate = Self::get_aggregate(env.clone(), ratee.clone());
        Rated {
            escrow_id,
            rater,
            ratee,
            score,
            count: aggregate.count,
            total_score: aggregate.total_score,
        }
        .publish(&env);
        Ok(())
    }

    /// Weighted reputation for `address`.
    ///
    /// Each counted rating was weighted by its escrow's `total_amount` when it
    /// was submitted; only the first rating from a given rater counts
    /// (anti-spam). Averaging is `total_score / weight`. Raw ratings are never
    /// modified.
    ///
    /// `submit` maintains the value, so this reads one storage entry and makes
    /// **no** cross-contract call, regardless of how many ratings exist. An
    /// address with no counted ratings returns the zero aggregate.
    pub fn get_aggregate(env: Env, address: Address) -> Aggregate {
        let key = DataKey::Aggregate(address);
        let stored: Option<Aggregate> = env.storage().persistent().get(&key);
        if stored.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        }
        stored.unwrap_or(Aggregate {
            total_score: 0,
            weight: 0,
            count: 0,
        })
    }

    /// Read a single rating (view).
    pub fn get_rating(env: Env, rater: Address, escrow_id: u64) -> Result<Rating, ReputationError> {
        env.storage()
            .persistent()
            .get(&DataKey::Rating(rater, escrow_id))
            .ok_or(ReputationError::NotFound)
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    fn extend_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

#[cfg(test)]
mod test;
