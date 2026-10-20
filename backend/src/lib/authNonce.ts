/**
 * authNonce.ts
 *
 * Single-use, DB-backed challenge nonces for wallet auth.
 *
 * A nonce is stored per address with a short expiry. `consumeNonce` validates it
 * against the stored row and deletes it, so a captured nonce cannot be replayed
 * and a restart/other instance does not lose outstanding challenges.
 *
 * Kept behind a narrow `AuthNonceStore` interface so the logic is unit-testable
 * without a database; `prisma.authNonce` structurally satisfies it.
 */

import { randomUUID } from "node:crypto";

/** Challenge/nonce lifetime. */
export const NONCE_TTL_MS = 60_000;

export interface AuthNonceRow {
  address: string;
  nonce: string;
  expiresAt: Date;
}

/** The subset of `prisma.authNonce` this module uses. */
export interface AuthNonceStore {
  upsert(args: {
    where: { address: string };
    create: AuthNonceRow;
    update: { nonce: string; expiresAt: Date };
  }): Promise<unknown>;
  deleteMany(args: {
    where: {
      address?: string;
      nonce?: string;
      expiresAt?: { lte?: Date; gt?: Date };
    };
  }): Promise<{ count: number }>;
}

/**
 * Issue (or replace) a nonce for `address`, expiring after `NONCE_TTL_MS`.
 * Expired rows are pruned opportunistically on each call.
 */
export async function issueNonce(
  db: AuthNonceStore,
  address: string,
  now: Date = new Date(),
): Promise<string> {
  const nonce = randomUUID();
  const expiresAt = new Date(now.getTime() + NONCE_TTL_MS);

  await db.deleteMany({ where: { expiresAt: { lte: now } } });
  await db.upsert({
    where: { address },
    create: { address, nonce, expiresAt },
    update: { nonce, expiresAt },
  });

  return nonce;
}

/**
 * Validate `nonce` for `address` against the stored row and delete it on success
 * (single use). Returns `false` for a missing, mismatched, or expired nonce.
 */
export async function consumeNonce(
  db: AuthNonceStore,
  address: string,
  nonce: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await db.deleteMany({
    where: { address, nonce, expiresAt: { gt: now } },
  });
  return result.count === 1;
}
