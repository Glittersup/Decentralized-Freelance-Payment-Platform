import { describe, it, expect } from "vitest";
import {
  consumeNonce,
  issueNonce,
  NONCE_TTL_MS,
  type AuthNonceRow,
  type AuthNonceStore,
} from "../lib/authNonce";

/** In-memory stand-in for `prisma.authNonce`. */
class FakeNonceStore implements AuthNonceStore {
  rows = new Map<string, AuthNonceRow>();

  async upsert(args: {
    where: { address: string };
    create: AuthNonceRow;
    update: { nonce: string; expiresAt: Date };
  }): Promise<unknown> {
    this.rows.set(args.create.address, { ...args.create });
    return undefined;
  }

  async deleteMany(args: {
    where: {
      address?: string;
      nonce?: string;
      expiresAt?: { lte?: Date; gt?: Date };
    };
  }): Promise<{ count: number }> {
    let count = 0;
    for (const [address, row] of this.rows) {
      const { where } = args;
      const addressMatches = where.address === undefined || where.address === address;
      const nonceMatches = where.nonce === undefined || where.nonce === row.nonce;
      const expiryMatches =
        where.expiresAt?.lte === undefined ||
        row.expiresAt.getTime() <= where.expiresAt.lte.getTime();
      const notExpired =
        where.expiresAt?.gt === undefined ||
        row.expiresAt.getTime() > where.expiresAt.gt.getTime();
      if (addressMatches && nonceMatches && expiryMatches && notExpired) {
        this.rows.delete(address);
        count += 1;
      }
    }
    return { count };
  }
}

const ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const OTHER = "GBVCHN3CR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

describe("auth nonces", () => {
  it("accepts a freshly issued nonce (valid flow)", async () => {
    const db = new FakeNonceStore();
    const now = new Date("2026-01-01T00:00:00Z");
    const nonce = await issueNonce(db, ADDRESS, now);

    expect(await consumeNonce(db, ADDRESS, nonce, now)).toBe(true);
  });

  it("rejects replay of an already-used nonce", async () => {
    const db = new FakeNonceStore();
    const now = new Date("2026-01-01T00:00:00Z");
    const nonce = await issueNonce(db, ADDRESS, now);

    expect(await consumeNonce(db, ADDRESS, nonce, now)).toBe(true);
    // Single use: the row was deleted, so the same nonce cannot be replayed.
    expect(await consumeNonce(db, ADDRESS, nonce, now)).toBe(false);
  });

  it("rejects an expired nonce", async () => {
    const db = new FakeNonceStore();
    const issuedAt = new Date("2026-01-01T00:00:00Z");
    const nonce = await issueNonce(db, ADDRESS, issuedAt);

    const later = new Date(issuedAt.getTime() + NONCE_TTL_MS);
    expect(await consumeNonce(db, ADDRESS, nonce, later)).toBe(false);
  });

  it("allows only one concurrent consumer", async () => {
    const db = new FakeNonceStore();
    const now = new Date("2026-01-01T00:00:00Z");
    const nonce = await issueNonce(db, ADDRESS, now);

    const results = await Promise.all([
      consumeNonce(db, ADDRESS, nonce, now),
      consumeNonce(db, ADDRESS, nonce, now),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("rejects a nonce issued for a different address", async () => {
    const db = new FakeNonceStore();
    const now = new Date("2026-01-01T00:00:00Z");
    const nonce = await issueNonce(db, ADDRESS, now);

    expect(await consumeNonce(db, OTHER, nonce, now)).toBe(false);
  });

  it("prunes expired nonces opportunistically", async () => {
    const db = new FakeNonceStore();
    const issuedAt = new Date("2026-01-01T00:00:00Z");
    await issueNonce(db, ADDRESS, issuedAt);

    const later = new Date(issuedAt.getTime() + NONCE_TTL_MS + 1);
    await issueNonce(db, OTHER, later);

    expect(db.rows.has(ADDRESS)).toBe(false);
    expect(db.rows.has(OTHER)).toBe(true);
  });
});
