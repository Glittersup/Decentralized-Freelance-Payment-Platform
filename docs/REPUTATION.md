# Reputation weighting and anti-spam

`reputation.submit` accepts a 1–5 rating once a job is `Completed` and the rater
is a participant. Every raw rating is stored unchanged; the **aggregate** that
`get_aggregate` returns is maintained from those raw ratings by `submit`.

## The rule

For an address, a rating counts toward its aggregate when:

1. **Anti-spam:** it is the *first* rating that rater has given this ratee.
   Later ratings from the same rater (in other escrows) are stored but do not
   count.
2. **Weighting:** the counted rating is weighted by its escrow's `total_amount`
   (read from the escrow contract during `submit`, which already loads the
   escrow to verify the job completed — so weighting costs no extra call).

`get_aggregate` returns:

```rust
Aggregate {
    total_score: u64, // sum(score * weight)
    weight: u64,      // sum(weight)
    count: u64,       // number of counted ratings
}
```

The average is `total_score / weight` (0 when `weight` is 0). `count` is the
number of ratings that counted, so the UI can still show "N review(s)".

This is integer-only (no floating point on-chain). Rounding is left to the
display layer.

## The API mirror

`GET /api/reputation/:address` returns the same aggregate the contract stores,
not a plain mean of the `Rating` rows (issue #34). The route folds the rows with
exactly the rule above (the `/ratings` listing beside it stays raw, one row per
review):

- rows are read oldest first, and the first row per `(rater, ratee)` is the one
  that counts — the `RatingCounted` marker;
- each counted row is weighted by `Job.totalAmountUsdc` converted to the job
  asset's base units (the same `total_amount` the escrow stores);
- a zero-weight row (a zero-amount escrow, or an asset the registry does not
  know) is not counted, matching the contract's `if weight > 0` guard.

The response extends the previous shape without breaking it:

```json
{
  "address": "G...",
  "averageScore": 3.2,
  "totalScore": "32000000000",
  "weight": "10000000000",
  "count": 2,
  "totalRatings": 2
}
```

`totalScore` and `weight` are the contract's `u64` fields as decimal strings,
so a client can compare them with `get_aggregate` exactly; `averageScore` is
`totalScore / weight` (0 when nothing counted) for display; `count` is the
number of counted ratings, while `totalRatings` remains the number of rows
received, so the profile can still say "N review(s)".

One caveat is inherent to the off-chain mirror: `POST /api/reputation` writes
the `Rating` row before the transaction is submitted, so a row whose
`reputation.submit` never confirmed can be reflected in the API while the chain
has not seen it. The idempotent `(rater, job)` key stops a duplicate, but the
chain remains the source of truth for a settled aggregate.

The freelancer directory (`GET /api/users/freelancers`) still sorts by the raw
mean of the rows; it is a discovery surface, not the aggregate the profile
shows, and is a candidate for the same helper in a follow-up.

## Cost model

Weighting is applied **once, in `submit`**, not recomputed on every read:

| Operation | Cross-contract calls | Storage work |
|-----------|----------------------|--------------|
| `submit` | 1 (`escrow.get`, already needed to verify the job) | O(1): the raw `Rating`, one `(ratee, rater)` marker, one `Aggregate` |
| `get_aggregate` | 0 | O(1): a single `Aggregate` read |
| `get_rating` | 0 | O(1) |

Nothing here scales with the number of ratings an address has received, so a
popular freelancer cannot become unreadable — or unratable — as their history
grows. That matters because the profile page polls `get_aggregate`.

`submit` is also what records "this rater has counted once": the presence of the
`(ratee, rater)` marker *is* the anti-spam check, so no growing per-ratee list is
deserialized or rewritten.

## Why this rule

- **Amount weighting** makes a high rating on a meaningful job worth more than a
  high rating on a trivial one, without changing the raw data.
- **One rating per (rater, ratee) pair** blunts the cheapest farm: a user can no
  longer inflate a counterparty (or themselves) by splitting work into many
  tiny escrows.

## Storage layout (upgrade note)

The aggregate lives under `DataKey::Aggregate(address)`, and the anti-spam
marker under `DataKey::RatingCounted(ratee, rater)`. Both replace the previous
`DataKey::RateeRaters(address)` list, which held an entry for *every* rating and
was deserialized and rewritten in full on each `submit` — the unbounded cost
this change removes.

Consequences:

- **Redeploy required.** A contract instance whose ratings predate this change
  has no stored aggregates, and the old list is no longer read, so
  `get_aggregate` returns zeros for those addresses. Deploy the new wasm with
  `scripts/deploy_testnet.sh`; contract ids change and `frontend/.env` is
  regenerated, as with any deploy.
- **Changing the rule later needs a rebuild.** Because the aggregate is now
  computed once and stored, a different weighting rule (recency decay, per-pair
  amount caps) needs existing aggregates recomputed rather than a small change
  to `get_aggregate`. `get_rating(rater, escrow_id)` and the `rated` event
  (see [`EVENTS.md`](./EVENTS.md), which carries `rater`, `ratee` and `score`)
  are the raw, rule-free records to rebuild from — the event is the
  enumerable one, since ratings themselves are keyed by `(rater, escrow_id)`.

## Residual sybil risk (not solved)

- A colluding pair can still rate each other once, and can choose the size of
  that one escrow to maximise its weight.
- The rule assumes escrow `total_amount` is real value; on testnet it is not.
- There is no decay by recency and no per-pair amount cap. These are deliberate
  omissions to keep the rule small and explainable, and are candidates for a
  follow-up.

This is a mitigation, not a guarantee.
