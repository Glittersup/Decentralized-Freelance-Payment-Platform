# Dispute resolution design

How a frozen escrow gets unfrozen: a panel of arbitrators rules by majority, with
a timelock escape hatch if they never do.

## Actors

- **Panel** — a list of unique arbitrator addresses, set once at `dispute.init`.
  `threshold` (M) of the N panel members must approve a resolution.
- **Parties** — the escrow's client and freelancer. Either may `raise` a dispute.
- **Escrow contract** — holds the funds and is the only contract that can move
  them; `escrow.resolve` is callable **only** by the registered dispute contract.

## Flow

```
1. Either party calls  escrow.open_dispute(escrow_id, initiator)
     → escrow status: Active → Disputed
     → records a dispute deadline (now + 7 days)

2. Either party calls  dispute.raise(escrow_id, escrow_contract, raised_by, reason)
     → verifies via escrow that the escrow is Disputed and raised_by is a party

3. At least `threshold` panel members call
       dispute.approve(dispute_id, arbitrator, client_share, freelancer_share)
     → each approval is authenticated by that arbitrator and bound to a split

4. Anyone calls       dispute.arbitrate(dispute_id, client_share, freelancer_share)
     → counts approvals matching exactly that split; needs >= threshold
     → escrow.resolve(escrow_id, client_share, freelancer_share)
         → escrow checks the shares sum to the funds still held, then pays out
         → escrow status: Disputed → Completed

   …or, if the panel never rules:

5. The client calls   escrow.reclaim_after_dispute_timeout(escrow_id)
     → only after the dispute deadline, only while Disputed
     → refunds the unreleased funds; escrow status: Disputed → Refunded
```

## Why these choices

- **Approvals are bound to a split.** Approving just "a resolution" would let any
  observer call `arbitrate` with arbitrary shares. Instead each `approve` records
  `(client_share, freelancer_share)` for that arbitrator, and `arbitrate` only
  counts approvals that match the split being executed. An arbitrator can change
  their vote by approving again.
- **`resolve` is unchanged and still independent.** It checks the shares sum to
  the escrow's remaining balance and that the caller is the registered dispute
  contract, so a compromised or buggy dispute contract cannot over- or under-pay.
- **`init` needs every panel member's signature.** This prevents an attacker from
  front-running a fresh deployment to install themselves as an arbitrator.
- **Timelock is a genuine escape hatch.** `reclaim_after_dispute_timeout` only
  fires after the deadline, only from `Disputed`, and moves the escrow to
  `Refunded`. A late ruling then fails `escrow.resolve`'s status check, so funds
  cannot be paid out twice.

## Off-chain record

The backend indexer mirrors these events into `Job` and `Dispute` rows, and three
properties of that mirror are deliberate:

- **Who runs the two transactions.** Steps 1 and 2 above are one user action:
  `useEscrow.openDispute` submits `escrow.open_dispute` and then
  `dispute.raise`. The backend builds both as well — `POST /api/disputes`
  returns the `open_dispute` XDR and `POST /api/disputes/:id/raise` the `raise`
  XDR — for API-first clients, and the frontend ignores both and encodes the
  calls itself. They cannot be reordered: `escrow.open_dispute` moves the escrow
  to `Disputed`, and `dispute.raise` cross-calls the escrow and rejects the call
  while it is not (`EscrowNotDisputed`).
- **Carrying the reason and the id.** The `Raised` event has no reason field —
  `dispute.raise` takes the reason as an argument and only the off-chain row can
  keep it — while the on-chain dispute id does not exist until `raise`
  confirms.  So the row is written by `POST /api/disputes` *before* either
  transaction as `PENDING`, and the id is attached afterwards by whichever writes first:
  `POST /api/disputes/:id/sync` (called by the frontend with the id the contract
  returned, so arbitrators can rule without waiting for a poll) or the indexer's
  `raised` handler. Both write the same row: `Dispute.jobId` is unique and both
  upsert on it. A job can therefore be `DISPUTED` with a `Dispute` row whose
  `onChainId` is still `null`, and that is the intended state between the two
  transactions: the reason is recorded, the id is not yet known.
- **A PENDING dispute is not user-visible.** `GET /api/disputes/:id` and the
  `disputes[]` on `GET /api/jobs/:id` only return rows with `onChainId` set, so
  a transaction that was built but never signed leaves no dispute behind. The
  row (and its reason) survives for a retry, and the first writer of the id —
  `/:id/sync` or the indexer — moves it to `RAISED`.
- **A refund is terminal and closes the dispute.** `refunded` is emitted by both
  `reclaim_expired` and `reclaim_after_dispute_timeout`. The indexer sets the job
  to `REFUNDED` and moves every still-open dispute for that escrow (`RAISED` or
  `UNDER_REVIEW`) to the terminal `REFUNDED` status, stamping `resolvedAt`. A
  `RESOLVED` dispute means a panel ruled; a `REFUNDED` dispute means the funds
  went back to the client without a ruling. `refunded` cannot arrive twice for
the same escrow (both refund paths are terminal), and no later event touches a
  refunded dispute.

The indexer reads an event's fields from its value map **and** its `#[topic]`
fields (`topic[1..]`), because every event except escrow's `created`/`funded`
carries `escrow_id` in `topic[1]` (see [`EVENTS.md`](./EVENTS.md)). Reading only
the value map is what left `handleRaised` — and every other post-funding
handler — with no id to look the row up by.

### The `raise` sequence, end to end

```
client                                backend                    chain
------                                -------                    -----
POST /api/disputes {jobId, reason} →  upsert Dispute(jobId)      —
                                      (no onChainId)  →
                                      ← {dispute, xdr}
escrow.open_dispute ─────────────────────────────────────────→  Active → Disputed
                                                                    emits dispute_opened
                                                                      → job: DISPUTED
POST /api/disputes/:id/raise ──────→  build dispute.raise (reason
                                      read from the row) →
                                      ← {xdr}
dispute.raise(escrow_id, escrow,                                     creates dispute #N
  raised_by, reason) ────────────────────────────────────────→      emits raised
  ← dispute id from simulation
POST /api/disputes/:id/sync {onChainId} → set Dispute.onChainId  —

                    …the panel then calls dispute.approve ×M, then arbitrate
```

`POST /api/disputes/:id/resolve` refuses with `409` while `onChainId` is null,
because `dispute.arbitrate` keys on the on-chain dispute id. That guard is the
only reason `sync` exists.

So `Dispute.status` has exactly two terminal values — `RESOLVED` and `REFUNDED`
— and any query for "open disputes" should filter on `RAISED`/`UNDER_REVIEW`.
The `clientShare`/`freelancerShare` of a `REFUNDED` dispute are **not** a
settlement split: a refund sends the entire remaining balance to the client, and
the indexer does not invent a share split it was never told.

## API summary

| Route | Who | What it does |
|-------|-----|--------------|
| `POST /api/disputes` | a party | Upserts the job's dispute row (the reason lives here) and returns the `escrow.open_dispute` XDR. Idempotent per job. |
| `GET /api/disputes/:id` | anyone | The row, with its party addresses. |
| `POST /api/disputes/:id/raise` | a party | Returns the `dispute.raise` XDR, using the stored reason. `409` if the dispute is already on-chain. |
| `POST /api/disputes/:id/sync` | a party | Records the on-chain dispute id returned by `raise`. |
| `POST /api/disputes/:id/resolve` | an `ARBITRATOR_ADDRESSES` member | Returns the `dispute.arbitrate` XDR for a split. `409` until the dispute is on-chain. Shares are whole units of the **job's** asset and are converted at that asset's `decimals` (issue #35), so a non-7-decimal token is encoded correctly; an asset the registry does not know is a `400`. |

Off-chain checks here are early rejections, not the security boundary: the
escrow and dispute contracts re-check every precondition on-chain (the escrow is
`Disputed`, the raiser is a party, the panel approved that exact split).

## Reproducing the flow on testnet

[`../scripts/demo_dispute_testnet.sh`](../scripts/demo_dispute_testnet.sh) walks
steps 1–4 above against the deployed testnet contracts — `open_dispute` →
`raise` → `approve` → `arbitrate` — and **asserts** the outcome: the escrow ends
`Completed` and the dispute `Resolved`, or the script exits non-zero. It is the
dispute counterpart to [`../scripts/demo_testnet.sh`](../scripts/demo_testnet.sh),
which only covers the happy path (`create → fund → release → rate → aggregate`).

```bash
scripts/deploy_testnet.sh          # once, to deploy + initialize
scripts/demo_dispute_testnet.sh    # freeze, raise, approve, arbitrate
```

`scripts/deploy_testnet.sh` initializes the panel as `[admin]` with
`threshold = 1`, so the demo approves the split once. For an M-of-N panel every
member calls `dispute.approve` with the **same** shares before anyone calls
`arbitrate`; `arbitrate` only counts approvals that match the split exactly.

## Residual risks

- The panel is a **trusted set**, not sybil-resistant. Their selection is an
  off-chain governance concern.
- There is no slashing or bonding for arbitrators who approve a bad split.
- The timelock is measured from `open_dispute` and is not extendable; a panel
  that needs more time must rule before the deadline or the client can reclaim.

Constants live in `contracts/escrow/src/lib.rs` (`DISPUTE_TIMEOUT_SECONDS`).
