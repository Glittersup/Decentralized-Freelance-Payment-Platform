/**
 * reputation.ts
 *
 * The off-chain mirror of `reputation.get_aggregate` (issue #34).
 *
 * The contract maintains a **weighted** aggregate, not a plain mean: each
 * counted rating is weighted by its escrow's `total_amount`, and only the first
 * rating a given rater gives a given ratee counts (anti-spam). See
 * `docs/REPUTATION.md` and `contracts/reputation/src/lib.rs`.
 *
 * `GET /api/reputation/:address` has to answer with the same numbers, or the
 * API and the Profile page — which reads the chain directly — disagree for the
 * same address. This module is that arithmetic, kept free of Prisma and HTTP so
 * it can be unit-tested against the contract's rule.
 */

import { getAsset, toBaseUnits } from "./assets";

/** The fields of a rating this calculation needs. */
export interface WeightedRating {
  score: number;
  /** The rater's user id; the anti-spam key is `(rater, ratee)`. */
  raterId: string;
  job: {
    /** `Job.totalAmountUsdc`, a Prisma Decimal in whole units. */
    totalAmountUsdc: { toString(): string } | string | number;
    /** Asset symbol the job pays in (see `lib/assets.ts`). */
    asset: string;
  };
}

/** `Aggregate` as the reputation contract stores and returns it. */
export interface WeightedAggregate {
  /** sum(score × weight) — `Aggregate.total_score` on chain. */
  totalScore: bigint;
  /** sum(weight) — `Aggregate.weight` on chain, the escrow totals. */
  weight: bigint;
  /** Number of ratings that counted — `Aggregate.count` on chain. */
  count: number;
}

/**
 * The weight of one rating: its escrow's `total_amount` in the asset's base
 * units. An asset the registry does not know has no defensible decimals, so its
 * weight is zero — the same treatment the contract gives a zero-amount escrow
 * (the rating is stored, but does not move the aggregate).
 */
function ratingWeight(rating: WeightedRating): bigint {
  try {
    const { decimals } = getAsset(rating.job.asset);
    return toBaseUnits(rating.job.totalAmountUsdc.toString(), decimals);
  } catch {
    return 0n;
  }
}

/**
 * Fold raw ratings into the contract's weighted aggregate.
 *
 * `ratings` must be ordered oldest first: "first rating from a given rater" is
 * the one that counted on chain. The route orders by `createdAt, id` so the
 * result is deterministic even when two rows share a timestamp.
 *
 * The replicate of the contract's rule matters in two places:
 * - the `(rater, ratee)` marker is set even when the weight is zero, so a later
 *   rating from that rater does **not** count either;
 * - the count is the number of counted ratings, not the number of rows.
 */
export function computeWeightedAggregate(
  ratings: readonly WeightedRating[],
): WeightedAggregate {
  const ratersCounted = new Set<string>();
  let totalScore = 0n;
  let weight = 0n;
  let count = 0;

  for (const rating of ratings) {
    if (ratersCounted.has(rating.raterId)) continue;
    ratersCounted.add(rating.raterId);

    const ratingWeightBaseUnits = ratingWeight(rating);
    if (ratingWeightBaseUnits <= 0n) continue;

    totalScore += BigInt(rating.score) * ratingWeightBaseUnits;
    weight += ratingWeightBaseUnits;
    count += 1;
  }

  return { totalScore, weight, count };
}
