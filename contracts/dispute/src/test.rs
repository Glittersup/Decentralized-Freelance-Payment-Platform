//! Unit tests for the dispute contract.
//!
//! These deploy a real escrow contract so the cross-contract verification and
//! the `escrow.resolve()` call are exercised for real.

#![cfg(test)]

use crate::{DisputeContract, DisputeContractClient, DisputeError, DisputeStatus};
use escrow::{EscrowContract, EscrowContractClient, Milestone};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, String, Vec,
};

struct Fx {
    env: Env,
    escrow: Address,
    dispute: Address,
    admin: Address,
    client: Address,
    freelancer: Address,
    token: Address,
    arbitrators: Vec<Address>,
    threshold: u32,
}

fn milestones(env: &Env, amounts: &[i128]) -> Vec<Milestone> {
    let mut v = Vec::new(env);
    for a in amounts {
        v.push_back(Milestone {
            amount: *a,
            released: false,
            released_amount: 0,
            deadline: 0,
        });
    }
    v
}

fn setup() -> Fx {
    setup_panel(1, 1)
}

fn setup_panel(arbitrator_count: u32, threshold: u32) -> Fx {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let client = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    StellarAssetClient::new(&env, &token).mint(&client, &10_000);

    let mut arbitrators = Vec::new(&env);
    for _ in 0..arbitrator_count {
        arbitrators.push_back(Address::generate(&env));
    }
    let admin = Address::generate(&env);

    let escrow = env.register(EscrowContract, ());
    let dispute = env.register(DisputeContract, ());

    EscrowContractClient::new(&env, &escrow).init(&admin, &dispute);
    DisputeContractClient::new(&env, &dispute).init(&admin, &arbitrators, &threshold);

    Fx {
        env,
        escrow,
        dispute,
        admin,
        client,
        freelancer,
        token,
        arbitrators,
        threshold,
    }
}

impl Fx {
    fn escrow_client(&self) -> EscrowContractClient<'_> {
        EscrowContractClient::new(&self.env, &self.escrow)
    }
    fn dispute_client(&self) -> DisputeContractClient<'_> {
        DisputeContractClient::new(&self.env, &self.dispute)
    }
    fn arbitrator(&self) -> Address {
        self.arbitrators.get(0).unwrap()
    }
    fn balance(&self, addr: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(addr)
    }
    fn reason(&self) -> String {
        String::from_str(&self.env, "work not delivered as agreed")
    }

    /// An escrow that has been funded and then frozen by a dispute.
    fn disputed(&self) -> u64 {
        let ec = self.escrow_client();
        let id = ec.create(
            &self.client,
            &self.freelancer,
            &self.token,
            &milestones(&self.env, &[1_000]),
            &10_000,
        );
        ec.fund(&id);
        ec.open_dispute(&id, &self.client);
        id
    }

    /// A funded (not frozen) escrow.
    fn funded(&self) -> u64 {
        let ec = self.escrow_client();
        let id = ec.create(
            &self.client,
            &self.freelancer,
            &self.token,
            &milestones(&self.env, &[1_000]),
            &10_000,
        );
        ec.fund(&id);
        id
    }

    /// Raise a dispute and return its id.
    fn raised(&self) -> (u64, u64) {
        let id = self.disputed();
        let dispute_id =
            self.dispute_client()
                .raise(&id, &self.escrow, &self.client, &self.reason());
        (id, dispute_id)
    }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

#[test]
fn init_twice_is_rejected() {
    let f = setup();
    let res = f
        .dispute_client()
        .try_init(&f.admin, &f.arbitrators, &f.threshold);
    assert!(matches!(res, Err(Ok(DisputeError::AlreadyInitialized))));
}

#[test]
fn init_rejects_empty_panel() {
    let env = Env::default();
    env.mock_all_auths();
    let dispute = env.register(DisputeContract, ());
    let admin = Address::generate(&env);
    let res =
        DisputeContractClient::new(&env, &dispute).try_init(&admin, &Vec::<Address>::new(&env), &1);
    assert!(matches!(res, Err(Ok(DisputeError::InvalidPanel))));
}

#[test]
fn init_rejects_duplicate_panel_members() {
    let env = Env::default();
    env.mock_all_auths();
    let dispute = env.register(DisputeContract, ());
    let arbitrator = Address::generate(&env);
    let mut panel = Vec::new(&env);
    panel.push_back(arbitrator.clone());
    panel.push_back(arbitrator);

    let res = DisputeContractClient::new(&env, &dispute).try_init(&panel, &2);
    assert!(matches!(res, Err(Ok(DisputeError::InvalidPanel))));
}

#[test]
fn init_rejects_bad_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    let dispute = env.register(DisputeContract, ());
    let admin = Address::generate(&env);
    let advocate = Address::generate(&env);
    let mut panel = Vec::new(&env);
    panel.push_back(advocate);
    // Threshold of 0 and more than the panel size are both invalid.
    for threshold in [0u32, 2] {
        let res = DisputeContractClient::new(&env, &dispute).try_init(&admin, &panel, &threshold);
        assert!(matches!(res, Err(Ok(DisputeError::InvalidThreshold))));
    }
}

#[test]
#[should_panic]
fn init_requires_admin_auth() {
    let env = Env::default();
    let dispute = env.register(DisputeContract, ());
    let admin = Address::generate(&env);
    let mut panel = Vec::new(&env);
    panel.push_back(Address::generate(&env));
    DisputeContractClient::new(&env, &dispute).init(&admin, &panel, &1);
}

#[test]
fn panel_updates_replace_members_and_invalidate_existing_approvals() {
    let f = setup();
    let (_, dispute_id) = f.raised();
    let old_arbitrator = f.arbitrator();
    f.dispute_client()
        .approve(&dispute_id, &old_arbitrator, &400, &600);

    let new_arbitrator = Address::generate(&f.env);
    let mut panel = Vec::new(&f.env);
    panel.push_back(new_arbitrator.clone());
    f.dispute_client().set_panel(&panel, &1);

    assert_eq!(f.dispute_client().arbitrators(), panel);
    assert_eq!(f.dispute_client().threshold(), 1);
    let res = f.dispute_client().try_arbitrate(&dispute_id, &400, &600);
    assert!(matches!(res, Err(Ok(DisputeError::InsufficientApprovals))));

    f.dispute_client()
        .approve(&dispute_id, &new_arbitrator, &400, &600);
    f.dispute_client().arbitrate(&dispute_id, &400, &600);
}

#[test]
fn panel_update_rejects_duplicate_members_and_invalid_threshold() {
    let f = setup();
    let arbitrator = Address::generate(&f.env);
    let mut duplicate_panel = Vec::new(&f.env);
    duplicate_panel.push_back(arbitrator.clone());
    duplicate_panel.push_back(arbitrator);
    let res = f.dispute_client().try_set_panel(&duplicate_panel, &1);
    assert!(matches!(res, Err(Ok(DisputeError::InvalidPanel))));

    let mut panel = Vec::new(&f.env);
    panel.push_back(Address::generate(&f.env));
    let res = f.dispute_client().try_set_panel(&panel, &0);
    assert!(matches!(res, Err(Ok(DisputeError::InvalidThreshold))));
}

#[test]
fn set_threshold_rejects_values_outside_panel_size() {
    let f = setup();
    for threshold in [0u32, 2] {
        let res = f.dispute_client().try_set_threshold(&threshold);
        assert!(matches!(res, Err(Ok(DisputeError::InvalidThreshold))));
    }
}

#[test]
fn set_threshold_updates_the_configured_value() {
    let f = setup_panel(3, 1);
    f.dispute_client().set_threshold(&2);
    assert_eq!(f.dispute_client().threshold(), 2);
}

#[test]
fn set_panel_before_init_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let dispute = env.register(DisputeContract, ());
    let mut panel = Vec::new(&env);
    panel.push_back(Address::generate(&env));
    let res = DisputeContractClient::new(&env, &dispute).try_set_panel(&panel, &1);
    assert!(matches!(res, Err(Ok(DisputeError::NotInitialized))));
}

#[test]
fn pause_blocks_raising_until_admin_unpauses() {
    let f = setup();
    let escrow_id = f.disputed();
    let dispute_id = f
        .dispute_client()
        .raise(&escrow_id, &f.escrow, &f.client, &f.reason());

    f.dispute_client().pause();
    assert!(f.dispute_client().is_paused());
    assert!(matches!(
        f.dispute_client()
            .try_raise(&escrow_id, &f.escrow, &f.client, &f.reason()),
        Err(Ok(DisputeError::Paused))
    ));
    assert!(matches!(
        f.dispute_client()
            .try_approve(&dispute_id, &f.arbitrator(), &1_000, &0),
        Err(Ok(DisputeError::Paused))
    ));
    assert!(matches!(
        f.dispute_client().try_arbitrate(&dispute_id, &1_000, &0),
        Err(Ok(DisputeError::Paused))
    ));

    f.dispute_client().unpause();
    assert!(!f.dispute_client().is_paused());
    f.dispute_client()
        .approve(&dispute_id, &f.arbitrator(), &1_000, &0);
    f.dispute_client().arbitrate(&dispute_id, &1_000, &0);
    assert_eq!(
        f.dispute_client().get(&dispute_id).status,
        DisputeStatus::Resolved
    );
}

#[test]
#[should_panic]
fn pause_requires_admin_authorization() {
    let f = setup();
    f.env.set_auths(&[]);
    f.dispute_client().pause();
}

// ---------------------------------------------------------------------------
// raise
// ---------------------------------------------------------------------------

#[test]
fn raise_requires_a_disputed_escrow() {
    let f = setup();
    let id = f.funded();
    let res = f
        .dispute_client()
        .try_raise(&id, &f.escrow, &f.client, &f.reason());
    assert!(matches!(res, Err(Ok(DisputeError::EscrowNotDisputed))));
}

#[test]
fn raise_by_stranger_is_rejected() {
    let f = setup();
    let id = f.disputed();
    let stranger = Address::generate(&f.env);
    let res = f
        .dispute_client()
        .try_raise(&id, &f.escrow, &stranger, &f.reason());
    assert!(matches!(res, Err(Ok(DisputeError::Unauthorized))));
}

#[test]
fn raise_twice_for_same_escrow_is_rejected() {
    let f = setup();
    let id = f.disputed();
    f.dispute_client()
        .raise(&id, &f.escrow, &f.client, &f.reason());
    let res = f
        .dispute_client()
        .try_raise(&id, &f.escrow, &f.client, &f.reason());
    assert!(matches!(res, Err(Ok(DisputeError::AlreadyRaised))));
}

#[test]
fn raise_unknown_escrow_is_rejected() {
    let f = setup();
    let res = f
        .dispute_client()
        .try_raise(&999, &f.escrow, &f.client, &f.reason());
    assert!(matches!(res, Err(Ok(DisputeError::EscrowNotFound))));
}

#[test]
fn raise_records_expected_state() {
    let f = setup();
    let (id, dispute_id) = f.raised();

    let d = f.dispute_client().get(&dispute_id);
    assert_eq!(d.status, DisputeStatus::Raised);
    assert_eq!(d.escrow_id, id);
    assert_eq!(d.raised_by, f.client);
    assert_eq!(f.dispute_client().dispute_for(&f.escrow, &id), dispute_id);
}

#[test]
fn two_escrow_contracts_can_each_raise_for_the_same_escrow_id() {
    let f = setup();
    // The first escrow contract raises a dispute for its escrow (id 0).
    let (id, first) = f.raised();

    // A second, unrelated escrow contract — a redeploy, or a staging instance —
    // whose first escrow happens to get the same id.
    let escrow2 = f.env.register(EscrowContract, ());
    EscrowContractClient::new(&f.env, &escrow2).init(&f.arbitrator(), &f.dispute);
    let ec2 = EscrowContractClient::new(&f.env, &escrow2);
    let id2 = ec2.create(
        &f.client,
        &f.freelancer,
        &f.token,
        &milestones(&f.env, &[1_000]),
        &10_000,
    );
    ec2.fund(&id2);
    ec2.open_dispute(&id2, &f.client);
    assert_eq!(id2, id, "both contracts number their first escrow the same");

    // Must not be blocked by the dispute on the other escrow contract.
    let second = f
        .dispute_client()
        .raise(&id2, &escrow2, &f.client, &f.reason());
    assert_ne!(second, first);

    // Each escrow contract resolves to its own dispute.
    assert_eq!(f.dispute_client().dispute_for(&f.escrow, &id), first);
    assert_eq!(f.dispute_client().dispute_for(&escrow2, &id2), second);
    assert_eq!(f.dispute_client().get(&second).escrow_id, id2);
}

// ---------------------------------------------------------------------------
// approve / arbitrate
// ---------------------------------------------------------------------------

#[test]
fn approve_by_non_panelist_is_rejected() {
    let f = setup();
    let (_, dispute_id) = f.raised();
    let stranger = Address::generate(&f.env);
    let res = f
        .dispute_client()
        .try_approve(&dispute_id, &stranger, &400, &600);
    assert!(matches!(res, Err(Ok(DisputeError::Unauthorized))));
}

#[test]
#[should_panic]
fn approve_requires_arbitrator_auth() {
    // Set up a raised dispute while auths are mocked, then disable mocking so
    // the missing panel authorization must panic.
    let f = setup();
    let (_, dispute_id) = f.raised();
    let arbitrator = f.arbitrator();
    f.env.set_auths(&[]);
    f.dispute_client()
        .approve(&dispute_id, &arbitrator, &400, &600);
}

#[test]
fn arbitrate_without_approvals_is_rejected() {
    let f = setup();
    let (_, dispute_id) = f.raised();
    let res = f.dispute_client().try_arbitrate(&dispute_id, &400, &600);
    assert!(matches!(res, Err(Ok(DisputeError::InsufficientApprovals))));
}

#[test]
fn arbitrate_reaching_threshold_distributes_funds_via_escrow() {
    let f = setup_panel(3, 2);
    let (id, dispute_id) = f.raised();

    // One approval is not enough...
    f.dispute_client()
        .approve(&dispute_id, &f.arbitrators.get(0).unwrap(), &400, &600);
    let res = f.dispute_client().try_arbitrate(&dispute_id, &400, &600);
    assert!(matches!(res, Err(Ok(DisputeError::InsufficientApprovals))));

    // ...a second matching approval reaches the 2-of-3 threshold.
    f.dispute_client()
        .approve(&dispute_id, &f.arbitrators.get(1).unwrap(), &400, &600);
    f.dispute_client().arbitrate(&dispute_id, &400, &600);

    assert_eq!(
        f.dispute_client().get(&dispute_id).status,
        DisputeStatus::Resolved
    );
    assert_eq!(f.balance(&f.client), 9_000 + 400);
    assert_eq!(f.balance(&f.freelancer), 600);
    assert_eq!(f.balance(&f.escrow), 0);
    assert_eq!(
        f.escrow_client().get(&id).status,
        escrow::EscrowStatus::Completed
    );
}

#[test]
fn arbitrate_ignores_approvals_for_a_different_split() {
    let f = setup_panel(3, 2);
    let (_, dispute_id) = f.raised();
    f.dispute_client()
        .approve(&dispute_id, &f.arbitrators.get(0).unwrap(), &1_000, &0);
    f.dispute_client()
        .approve(&dispute_id, &f.arbitrators.get(1).unwrap(), &0, &1_000);

    // Each arbitrator approved a *different* split, so nobody has approved
    // (400, 600).
    let res = f.dispute_client().try_arbitrate(&dispute_id, &400, &600);
    assert!(matches!(res, Err(Ok(DisputeError::InsufficientApprovals))));
}

#[test]
fn arbitrate_with_invalid_shares_is_rejected_by_escrow() {
    let f = setup();
    let (_, dispute_id) = f.raised();
    // 400 + 400 != 1000 held in escrow; the panel approves, escrow rejects.
    f.dispute_client()
        .approve(&dispute_id, &f.arbitrator(), &400, &400);
    let res = f.dispute_client().try_arbitrate(&dispute_id, &400, &400);
    assert!(matches!(res, Err(Ok(DisputeError::EscrowRejected))));
    // Nothing moved.
    assert_eq!(f.balance(&f.escrow), 1_000);
}

#[test]
fn arbitrate_twice_is_rejected() {
    let f = setup();
    let (_, dispute_id) = f.raised();
    f.dispute_client()
        .approve(&dispute_id, &f.arbitrator(), &1_000, &0);
    f.dispute_client().arbitrate(&dispute_id, &1_000, &0);
    let res = f.dispute_client().try_arbitrate(&dispute_id, &1_000, &0);
    assert!(matches!(res, Err(Ok(DisputeError::InvalidStatus))));
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

#[test]
fn panel_and_threshold_are_readable() {
    let f = setup_panel(3, 2);
    assert_eq!(f.dispute_client().threshold(), 2);
    assert_eq!(f.dispute_client().arbitrators(), f.arbitrators);
}

#[test]
#[should_panic]
fn set_panel_requires_admin_auth() {
    let f = setup();
    let mut panel = Vec::new(&f.env);
    panel.push_back(Address::generate(&f.env));
    f.env.set_auths(&[]);
    f.dispute_client().set_panel(&panel, &1);
}

#[test]
fn dispute_for_an_escrow_without_a_dispute_is_not_found() {
    let f = setup();
    f.disputed(); // frozen, but never raised
    let res = f.dispute_client().try_dispute_for(&f.escrow, &0);
    assert!(matches!(res, Err(Ok(DisputeError::NotFound))));
}
