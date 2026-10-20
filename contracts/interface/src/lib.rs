//! Shared interface crate.
//!
//! Holds the types and cross-contract client used by more than one contract.
//! It is a plain `rlib` (no contract, no exported ABI symbols), so contracts can
//! depend on it without colliding on exported entry-point names.
//!
//! Only put things here that are genuinely shared between contracts.

#![no_std]

use soroban_sdk::{contractclient, contracterror, contracttype, Address, Env, Vec};

// ---------------------------------------------------------------------------
// Escrow types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum EscrowStatus {
    Created,
    Active,
    Completed,
    Disputed,
    Refunded,
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub struct Milestone {
    pub amount: i128,
    /// `true` once `released_amount == amount` (all of it has been paid out).
    pub released: bool,
    /// How much of `amount` has already been released (starts at 0).
    pub released_amount: i128,
    /// Unix timestamp by which this milestone is expected to be released.
    ///
    /// **Advisory only — the escrow does not enforce it.** There is no
    /// per-milestone reclaim: `reclaim_expired` refunds *every* unreleased
    /// milestone once the escrow-level `expiry` passes, and the contract never
    /// reads a milestone's `deadline`. Treat it as descriptive metadata until
    /// per-milestone reclaim is implemented (see issue #48).
    pub deadline: u64,
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub struct EscrowData {
    pub client: Address,
    pub freelancer: Address,
    pub token: Address,
    pub total_amount: i128,
    pub milestones: Vec<Milestone>,
    pub status: EscrowStatus,
    pub created_at: u64,
    /// Safety timelock: if no activity by this timestamp, client can reclaim.
    pub expiry: u64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum EscrowError {
    NotFound = 1,
    InvalidStatus = 2,
    Unauthorized = 3,
    MilestoneAlreadyReleased = 4,
    MilestoneIndexOutOfBounds = 5,
    NotExpired = 6,
    ZeroAmount = 7,
    InvalidMilestones = 8,
    InvalidExpiry = 9,
    InvalidCounterparty = 10,
    AlreadyInitialized = 11,
    NotInitialized = 12,
    InvalidShares = 13,
    Overflow = 14,
    AmountExceedsMilestone = 15,
    DisputeTimeoutNotReached = 16,
    /// The milestone list exceeds [`MAX_MILESTONES`].
    TooManyMilestones = 17,
    /// A configured dispute timeout must be greater than zero.
    InvalidDisputeTimeout = 18,
}

// ---------------------------------------------------------------------------
// Cross-contract client
// ---------------------------------------------------------------------------

/// Methods the dispute and reputation contracts call on the escrow contract.
#[contractclient(name = "EscrowClient")]
pub trait EscrowInterface {
    fn get(env: Env, escrow_id: u64) -> Result<EscrowData, EscrowError>;
    fn resolve(
        env: Env,
        escrow_id: u64,
        client_share: i128,
        freelancer_share: i128,
    ) -> Result<(), EscrowError>;
}
