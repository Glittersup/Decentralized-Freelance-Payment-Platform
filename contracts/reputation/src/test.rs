//! Unit tests for the reputation contract.
//!
//! Deploys a real escrow contract so the "job must be completed" and
//! "caller must be a participant" checks are exercised for real.

#![cfg(test)]

use crate::{ReputationContract, ReputationContractClient, ReputationError};
use escrow::{EscrowContract, EscrowContractClient, Milestone};
use interface::{EscrowData, EscrowError, EscrowStatus};
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Events as _, Ledger},
    token::StellarAssetClient,
    xdr, Address, Env, Map, Symbol, TryFromVal, Val, Vec,
};

struct Fx {
    env: Env,
    escrow: Address,
    reputation: Address,
    client: Address,
    freelancer: Address,
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

fn setup() -> Fx {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let client = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let admin = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    StellarAssetClient::new(&env, &token).mint(&client, &10_000);

    let escrow = env.register(EscrowContract, ());
    let reputation = env.register(ReputationContract, ());
    EscrowContractClient::new(&env, &escrow).init(&admin, &escrow);
    ReputationContractClient::new(&env, &reputation).init(&admin, &escrow);

    Fx {
        env,
        escrow,
        reputation,
        client,
        freelancer,
        token,
    }
}

impl Fx {
    fn escrow_client(&self) -> EscrowContractClient<'_> {
        EscrowContractClient::new(&self.env, &self.escrow)
    }
    fn rep_client(&self) -> ReputationContractClient<'_> {
        ReputationContractClient::new(&self.env, &self.reputation)
    }

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

    fn completed(&self) -> u64 {
        let id = self.funded();
        self.escrow_client().release_milestone(&id, &0);
        id
    }

    /// A completed escrow of `amount` between `payer` and the freelancer.
    fn completed_with(&self, payer: &Address, amount: i128) -> u64 {
        StellarAssetClient::new(&self.env, &self.token).mint(payer, &amount);
        let ec = self.escrow_client();
        let id = ec.create(
            payer,
            &self.freelancer,
            &self.token,
            &milestones(&self.env, &[amount]),
            &10_000,
        );
        ec.fund(&id);
        ec.release_milestone(&id, &0);
        id
    }
}

// ---------------------------------------------------------------------------
// Event log helpers
// ---------------------------------------------------------------------------

/// Decode the data map of the first event named `name` in the event log.
fn event_data(env: &Env, name: &str) -> Val {
    for e in env.events().all().events() {
        let xdr::ContractEventBody::V0(body) = &e.body;
        let Some(topic0) = body.topics.first() else {
            continue;
        };
        let topic_val = Val::try_from_val(env, topic0).unwrap();
        if Symbol::try_from_val(env, &topic_val).unwrap() == Symbol::new(env, name) {
            return Val::try_from_val(env, &body.data).unwrap();
        }
    }
    panic!("event {name:?} not found");
}

/// Read a named field out of an event's data map.
fn field<T: TryFromVal<Env, Val>>(env: &Env, data: &Val, name: &str) -> T {
    let map = Map::<Symbol, Val>::try_from_val(env, data).unwrap();
    let value = map.get(Symbol::new(env, name)).unwrap();
    T::try_from_val(env, &value).unwrap()
}

// ---------------------------------------------------------------------------
// submit validation
// ---------------------------------------------------------------------------

#[test]
fn submit_before_completion_is_rejected() {
    let f = setup();
    let id = f.funded();
    let res = f.rep_client().try_submit(&f.client, &f.freelancer, &id, &5);
    assert!(matches!(res, Err(Ok(ReputationError::EscrowNotCompleted))));
}

#[test]
fn submit_unknown_escrow_is_rejected() {
    let f = setup();
    let res = f
        .rep_client()
        .try_submit(&f.client, &f.freelancer, &404, &5);
    assert!(matches!(res, Err(Ok(ReputationError::EscrowNotFound))));
}

#[test]
fn submit_with_invalid_score_is_rejected() {
    let f = setup();
    let id = f.completed();
    for score in [0u32, 6, 100] {
        let res = f
            .rep_client()
            .try_submit(&f.client, &f.freelancer, &id, &score);
        assert!(
            matches!(res, Err(Ok(ReputationError::InvalidScore))),
            "score {score} must be rejected"
        );
    }
}

#[test]
fn submit_by_non_participant_is_rejected() {
    let f = setup();
    let id = f.completed();
    let stranger = Address::generate(&f.env);
    let res = f.rep_client().try_submit(&stranger, &f.freelancer, &id, &5);
    assert!(matches!(res, Err(Ok(ReputationError::Unauthorized))));
}

#[test]
fn submit_with_wrong_ratee_is_rejected() {
    let f = setup();
    let id = f.completed();
    let stranger = Address::generate(&f.env);
    // The client may only rate the freelancer of this job.
    let res = f.rep_client().try_submit(&f.client, &stranger, &id, &5);
    assert!(matches!(res, Err(Ok(ReputationError::InvalidRatee))));
}

#[test]
fn duplicate_rating_is_rejected() {
    let f = setup();
    let id = f.completed();
    f.rep_client().submit(&f.client, &f.freelancer, &id, &5);
    let res = f.rep_client().try_submit(&f.client, &f.freelancer, &id, &4);
    assert!(matches!(res, Err(Ok(ReputationError::AlreadyRated))));
}

#[test]
fn zero_weight_rating_does_not_consume_the_pair_count() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let client = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let admin = Address::generate(&env);
    let escrow = env.register(MockEscrow, ());
    MockEscrowClient::new(&env, &escrow).init(&EscrowData {
        client: client.clone(),
        freelancer: freelancer.clone(),
        token: Address::generate(&env),
        total_amount: 0,
        milestones: Vec::new(&env),
        status: EscrowStatus::Completed,
        created_at: 0,
        expiry: 10_000,
    });

    let reputation = env.register(ReputationContract, ());
    let rep = ReputationContractClient::new(&env, &reputation);
    rep.init(&admin, &escrow);

    rep.submit(&client, &freelancer, &0, &5);
    let aggregate = rep.get_aggregate(&freelancer);
    assert_eq!(aggregate.count, 0);
    assert_eq!(aggregate.weight, 0);
    assert_eq!(rep.get_rating(&client, &0).score, 5);

    MockEscrowClient::new(&env, &escrow).set_total_amount(&1_000);
    rep.submit(&client, &freelancer, &1, &4);

    let aggregate = rep.get_aggregate(&freelancer);
    assert_eq!(aggregate.count, 1);
    assert_eq!(aggregate.weight, 1_000);
    assert_eq!(aggregate.total_score, 4_000);
}

// ---------------------------------------------------------------------------
// weighted aggregate
// ---------------------------------------------------------------------------

#[test]
fn both_parties_rate_and_aggregate_updates() {
    let f = setup();
    let id = f.completed();

    f.rep_client().submit(&f.client, &f.freelancer, &id, &5);
    f.rep_client().submit(&f.freelancer, &f.client, &id, &4);

    // The escrow is 1_000, so each aggregate is weighted by 1_000.
    let freelancer_agg = f.rep_client().get_aggregate(&f.freelancer);
    assert_eq!(freelancer_agg.count, 1);
    assert_eq!(freelancer_agg.weight, 1_000);
    assert_eq!(freelancer_agg.total_score, 5_000);

    let client_agg = f.rep_client().get_aggregate(&f.client);
    assert_eq!(client_agg.count, 1);
    assert_eq!(client_agg.weight, 1_000);
    assert_eq!(client_agg.total_score, 4_000);

    let rating = f.rep_client().get_rating(&f.client, &id);
    assert_eq!(rating.score, 5);
    assert_eq!(rating.ratee, f.freelancer);
}

#[test]
fn aggregate_equal_size_jobs_is_the_plain_average() {
    let f = setup();
    let other_client = Address::generate(&f.env);
    let id_a = f.completed_with(&f.client, 500);
    let id_b = f.completed_with(&other_client, 500);

    f.rep_client().submit(&f.client, &f.freelancer, &id_a, &5);
    f.rep_client()
        .submit(&other_client, &f.freelancer, &id_b, &3);

    let agg = f.rep_client().get_aggregate(&f.freelancer);
    assert_eq!(agg.count, 2);
    assert_eq!(agg.weight, 1_000);
    assert_eq!(agg.total_score, 4_000);
    // Average = total_score / weight = 4.0
    assert_eq!(agg.total_score / agg.weight, 4);
}

#[test]
fn aggregate_weights_ratings_by_escrow_amount() {
    let f = setup();
    let big_client = Address::generate(&f.env);
    let small = f.completed_with(&f.client, 100);
    let big = f.completed_with(&big_client, 900);

    f.rep_client().submit(&f.client, &f.freelancer, &small, &5);
    f.rep_client().submit(&big_client, &f.freelancer, &big, &1);

    let agg = f.rep_client().get_aggregate(&f.freelancer);
    assert_eq!(agg.count, 2);
    assert_eq!(agg.weight, 1_000);
    // 5*100 + 1*900 = 1_400, so average 1.4 — the low score on the big job dominates.
    assert_eq!(agg.total_score, 1_400);
}

#[test]
fn anti_spam_only_first_rating_per_pair_counts() {
    let f = setup();
    // The same client completes two escrows with the same freelancer.
    let first = f.completed_with(&f.client, 100);
    let second = f.completed_with(&f.client, 900);

    f.rep_client().submit(&f.client, &f.freelancer, &first, &5);
    f.rep_client().submit(&f.client, &f.freelancer, &second, &1);

    // Only the first (rater, ratee) pair counts, so the 900 job is ignored.
    let agg = f.rep_client().get_aggregate(&f.freelancer);
    assert_eq!(agg.count, 1);
    assert_eq!(agg.weight, 100);
    assert_eq!(agg.total_score, 500);
}

#[test]
fn raw_ratings_are_preserved_for_both_escrows() {
    let f = setup();
    let first = f.completed_with(&f.client, 100);
    let second = f.completed_with(&f.client, 900);
    f.rep_client().submit(&f.client, &f.freelancer, &first, &5);
    f.rep_client().submit(&f.client, &f.freelancer, &second, &1);

    // Both raw ratings remain readable even though only one is weighted.
    assert_eq!(f.rep_client().get_rating(&f.client, &first).score, 5);
    assert_eq!(f.rep_client().get_rating(&f.client, &second).score, 1);
}

#[test]
fn aggregate_for_unknown_address_is_empty() {
    let f = setup();
    let agg = f.rep_client().get_aggregate(&Address::generate(&f.env));
    assert_eq!(agg.count, 0);
    assert_eq!(agg.total_score, 0);
    assert_eq!(agg.weight, 0);
}

#[test]
fn aggregate_stays_correct_with_many_ratings() {
    let f = setup();

    // 60 distinct raters, each completing a 10-unit job. The aggregate that
    // `submit` maintains has to stay exact as it grows.
    let mut expected_total: u64 = 0;
    for i in 0..60u32 {
        let payer = Address::generate(&f.env);
        let id = f.completed_with(&payer, 10);
        let score = (i % 5) + 1; // 1..=5
        f.rep_client().submit(&payer, &f.freelancer, &id, &score);
        expected_total += (score as u64) * 10;
    }

    let agg = f.rep_client().get_aggregate(&f.freelancer);
    assert_eq!(agg.count, 60);
    assert_eq!(agg.weight, 600);
    assert_eq!(agg.total_score, expected_total);
}

// ---------------------------------------------------------------------------
// A switchable escrow, to prove `get_aggregate` never calls it
// ---------------------------------------------------------------------------

#[contracttype]
enum MockKey {
    Escrow,
    Failing,
}

/// Minimal escrow stand-in for one `Completed` job. It can be switched to
/// erroring on `get`, so that only a reputation contract that does **not**
/// cross-call the escrow can still answer a read.
#[contract]
pub struct MockEscrow;

#[contractimpl]
impl MockEscrow {
    pub fn init(env: Env, escrow: EscrowData) {
        env.storage().instance().set(&MockKey::Escrow, &escrow);
        env.storage().instance().set(&MockKey::Failing, &false);
    }

    pub fn set_failing(env: Env, failing: bool) {
        env.storage().instance().set(&MockKey::Failing, &failing);
    }

    pub fn set_total_amount(env: Env, amount: i128) {
        let mut escrow: EscrowData = env.storage().instance().get(&MockKey::Escrow).unwrap();
        escrow.total_amount = amount;
        env.storage().instance().set(&MockKey::Escrow, &escrow);
    }

    pub fn get(env: Env, _escrow_id: u64) -> Result<EscrowData, EscrowError> {
        if env
            .storage()
            .instance()
            .get::<_, bool>(&MockKey::Failing)
            .unwrap_or(false)
        {
            return Err(EscrowError::NotFound);
        }
        env.storage()
            .instance()
            .get(&MockKey::Escrow)
            .ok_or(EscrowError::NotFound)
    }
}

#[test]
fn get_aggregate_does_not_call_the_escrow() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let client = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let admin = Address::generate(&env);

    let escrow = env.register(MockEscrow, ());
    MockEscrowClient::new(&env, &escrow).init(&EscrowData {
        client: client.clone(),
        freelancer: freelancer.clone(),
        token: Address::generate(&env),
        total_amount: 1_000,
        milestones: Vec::new(&env),
        status: EscrowStatus::Completed,
        created_at: 0,
        expiry: 10_000,
    });

    let reputation = env.register(ReputationContract, ());
    let rep = ReputationContractClient::new(&env, &reputation);
    rep.init(&admin, &escrow);

    rep.submit(&client, &freelancer, &0, &5);
    assert_eq!(rep.get_aggregate(&freelancer).count, 1);

    // Take the escrow away. A read that still fetched the weight from it would
    // drop the rating (the derived implementation returned a zero aggregate
    // here); the maintained aggregate must be unaffected.
    MockEscrowClient::new(&env, &escrow).set_failing(&true);

    let agg = rep.get_aggregate(&freelancer);
    assert_eq!(agg.count, 1);
    assert_eq!(agg.weight, 1_000);
    assert_eq!(agg.total_score, 5_000);
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

#[test]
fn rated_event_carries_resulting_aggregate() {
    let f = setup();
    let id = f.completed();
    f.rep_client().submit(&f.client, &f.freelancer, &id, &5);

    let data = event_data(&f.env, "rated");
    let ratee: Address = field(&f.env, &data, "ratee");
    let count: u64 = field(&f.env, &data, "count");
    let total_score: u64 = field(&f.env, &data, "total_score");

    assert_eq!(ratee, f.freelancer);
    assert_eq!(count, 1);
    assert_eq!(total_score, 5_000);
}

// ---------------------------------------------------------------------------
// authorization
// ---------------------------------------------------------------------------

#[test]
#[should_panic]
fn init_requires_admin_auth() {
    // Fresh env with no mocked auths: `admin.require_auth()` must panic.
    let env = Env::default();
    let reputation = env.register(ReputationContract, ());
    let admin = Address::generate(&env);
    let escrow = Address::generate(&env);
    ReputationContractClient::new(&env, &reputation).init(&admin, &escrow);
}

#[test]
fn set_escrow_contract_before_init_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let reputation = env.register(ReputationContract, ());
    let escrow = Address::generate(&env);
    let res = ReputationContractClient::new(&env, &reputation).try_set_escrow_contract(&escrow);
    assert!(matches!(res, Err(Ok(ReputationError::NotInitialized))));
}

#[test]
fn set_escrow_contract_updates_the_trusted_contract() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let client = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let admin = Address::generate(&env);
    let unavailable_escrow = Address::generate(&env);
    let escrow = env.register(MockEscrow, ());
    MockEscrowClient::new(&env, &escrow).init(&EscrowData {
        client: client.clone(),
        freelancer: freelancer.clone(),
        token: Address::generate(&env),
        total_amount: 1_000,
        milestones: Vec::new(&env),
        status: EscrowStatus::Completed,
        created_at: 0,
        expiry: 10_000,
    });

    let reputation = env.register(ReputationContract, ());
    let rep = ReputationContractClient::new(&env, &reputation);
    rep.init(&admin, &unavailable_escrow);
    rep.set_escrow_contract(&escrow);

    rep.submit(&client, &freelancer, &0, &5);
    assert_eq!(rep.get_aggregate(&freelancer).total_score, 5_000);
}

#[test]
#[should_panic]
fn set_escrow_contract_requires_admin_auth() {
    let f = setup();
    f.env.set_auths(&[]);
    f.rep_client()
        .set_escrow_contract(&Address::generate(&f.env));
}

#[test]
#[should_panic]
fn submit_requires_rater_auth() {
    // Complete a job while auths are mocked, then disable mocking so the
    // missing rater authorization must panic.
    let f = setup();
    let id = f.completed();
    f.env.set_auths(&[]);
    f.rep_client().submit(&f.client, &f.freelancer, &id, &5);
}
