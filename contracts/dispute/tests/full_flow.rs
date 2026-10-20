//! Integration test: the full flow across all three contracts.
//!
//! Covers the target target flow from the project brief:
//!   create job → fund escrow with USDC → release milestones → both parties rate
//! plus the dispute branch:
//!   fund → open_dispute → raise → arbitrate → both parties rate

use dispute::{DisputeContract, DisputeContractClient};
use escrow::{EscrowContract, EscrowContractClient, EscrowStatus, Milestone};
use reputation::{ReputationContract, ReputationContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, String, Vec,
};

struct World {
    env: Env,
    escrow: Address,
    dispute: Address,
    reputation: Address,
    client: Address,
    freelancer: Address,
    arbitrator: Address,
    token: Address,
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

fn world() -> World {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let client = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    // A Stellar Asset Contract standing in for USDC.
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    StellarAssetClient::new(&env, &token).mint(&client, &10_000);

    let escrow = env.register(EscrowContract, ());
    let dispute = env.register(DisputeContract, ());
    let reputation = env.register(ReputationContract, ());

    let mut panel = Vec::new(&env);
    panel.push_back(arbitrator.clone());
    EscrowContractClient::new(&env, &escrow).init(&arbitrator, &dispute);
    DisputeContractClient::new(&env, &dispute).init(&arbitrator, &panel, &1);
    ReputationContractClient::new(&env, &reputation).init(&arbitrator, &escrow);

    World {
        env,
        escrow,
        dispute,
        reputation,
        client,
        freelancer,
        arbitrator,
        token,
    }
}

impl World {
    fn escrow_c(&self) -> EscrowContractClient<'_> {
        EscrowContractClient::new(&self.env, &self.escrow)
    }
    fn dispute_c(&self) -> DisputeContractClient<'_> {
        DisputeContractClient::new(&self.env, &self.dispute)
    }
    fn rep_c(&self) -> ReputationContractClient<'_> {
        ReputationContractClient::new(&self.env, &self.reputation)
    }
    fn balance(&self, addr: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(addr)
    }
    fn create_fund(&self, amounts: &[i128]) -> u64 {
        let id = self.escrow_c().create(
            &self.client,
            &self.freelancer,
            &self.token,
            &milestones(&self.env, amounts),
            &10_000,
        );
        self.escrow_c().fund(&id);
        id
    }
}

#[test]
fn happy_path_milestones_then_ratings() {
    let w = world();

    // 1. Client creates and funds a 300 + 700 escrow.
    let id = w.create_fund(&[300, 700]);
    assert_eq!(w.escrow_c().get(&id).status, EscrowStatus::Active);
    assert_eq!(w.balance(&w.escrow), 1_000);

    // 2. Client releases each milestone.
    w.escrow_c().release_milestone(&id, &0);
    assert_eq!(w.balance(&w.freelancer), 300);
    w.escrow_c().release_milestone(&id, &1);
    assert_eq!(w.balance(&w.freelancer), 1_000);
    assert_eq!(w.balance(&w.escrow), 0);
    assert_eq!(w.escrow_c().get(&id).status, EscrowStatus::Completed);

    // 3. Both parties rate each other.
    w.rep_c().submit(&w.client, &w.freelancer, &id, &5);
    w.rep_c().submit(&w.freelancer, &w.client, &id, &4);

    // Weighted by the 1_000 escrow, so scores are scaled by 1_000.
    assert_eq!(w.rep_c().get_aggregate(&w.freelancer).total_score, 5_000);
    assert_eq!(w.rep_c().get_aggregate(&w.client).total_score, 4_000);
}

#[test]
fn dispute_path_arbitrates_then_ratings() {
    let w = world();

    // 1. Fund, then the freelancer raises a dispute.
    let id = w.create_fund(&[1_000]);
    w.escrow_c().open_dispute(&id, &w.freelancer);
    assert_eq!(w.escrow_c().get(&id).status, EscrowStatus::Disputed);

    // 2. The dispute contract verifies the escrow is frozen, an arbitrator
    //    approves a split, then arbitrate splits the funds.
    assert_eq!(w.dispute_c().threshold(), 1);
    assert_eq!(w.escrow_c().dispute_contract(), w.dispute);
    let reason = String::from_str(&w.env, "deliverable rejected");
    let dispute_id = w.dispute_c().raise(&id, &w.escrow, &w.freelancer, &reason);
    w.dispute_c()
        .approve(&dispute_id, &w.arbitrator, &250, &750);
    w.dispute_c().arbitrate(&dispute_id, &250, &750);

    assert_eq!(w.balance(&w.client), 10_000 - 1_000 + 250);
    assert_eq!(w.balance(&w.freelancer), 750);
    assert_eq!(w.balance(&w.escrow), 0);
    assert_eq!(w.escrow_c().get(&id).status, EscrowStatus::Completed);

    // 3. The resolved job is completed, so it can be rated.
    w.rep_c().submit(&w.client, &w.freelancer, &id, &3);
    assert_eq!(w.rep_c().get_aggregate(&w.freelancer).count, 1);
}

#[test]
fn expired_escrow_is_reclaimed_by_client() {
    let w = world();
    let id = w.create_fund(&[400, 600]);
    w.escrow_c().release_milestone(&id, &0); // 400 paid

    // Past the safety expiry.
    w.env.ledger().set_timestamp(10_001);
    w.escrow_c().reclaim_expired(&id);

    assert_eq!(w.escrow_c().get(&id).status, EscrowStatus::Refunded);
    assert_eq!(w.balance(&w.client), 10_000 - 1_000 + 600);
    assert_eq!(w.balance(&w.freelancer), 400);
    assert_eq!(w.balance(&w.escrow), 0);

    // A refunded escrow is not "completed", so it cannot be rated.
    let res = w.rep_c().try_submit(&w.client, &w.freelancer, &id, &5);
    assert!(res.is_err());
}
