import { describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";

/**
 * Dedicated rate limiting for the wallet-auth endpoints (issue #44).
 *
 * `app.ts` applied one global limiter (100/min/IP) to every route, including
 * `GET /api/users/challenge` and `POST /api/users/auth`. Nothing limited nonce
 * issuance or signature attempts beyond that, so a single IP could make 100
 * nonce writes — or 100 signature attempts — a minute.
 *
 * These tests drive the real `createApp()` wiring with a two-request budget, so
 * removing either `app.use(...)` mount fails here. The two mounts are asserted
 * to be independent: exhausting the challenge budget must not block the auth
 * call, or a client that fetched a challenge twice could not complete the flow.
 */

// config.ts reads the environment at import time; keep this above every import
// that pulls it in. Two requests makes the limit observable in three calls.
process.env.AUTH_RATE_LIMIT_MAX = "2";
process.env.AUTH_RATE_LIMIT_WINDOW_MS = "60000";

const ADDRESS = Keypair.random().publicKey();

const h = vi.hoisted(() => ({
  authNonce: {
    upsert: vi.fn(async () => ({})),
    findUnique: vi.fn(async () => null),
    delete: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  },
}));

// The auth routes are the only ones these tests reach; everything else in the
// app is never invoked, so a single-model mock is enough.
vi.mock("../db", () => ({ prisma: { authNonce: h.authNonce } }));

/** Start a fresh app (and therefore fresh limiter stores) for one test. */
async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const { createApp } = await import("../app");
  const server: Server = await new Promise((resolve) => {
    const s = createApp().listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");

  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const challenge = (baseUrl: string) =>
  fetch(`${baseUrl}/api/users/challenge?address=${encodeURIComponent(ADDRESS)}`);

const authenticate = (baseUrl: string) =>
  fetch(`${baseUrl}/api/users/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // A structurally valid body: validation passes and the route answers 401
    // (no stored nonce), which is what a scripted attempt would do.
    body: JSON.stringify({ address: ADDRESS, signature: "sig", nonce: "nonce" }),
  });

describe("GET /api/users/challenge rate limit", () => {
  it("rejects requests beyond the dedicated budget with a JSON 429", async () => {
    await withApp(async (baseUrl) => {
      expect((await challenge(baseUrl)).status).toBe(200);
      expect((await challenge(baseUrl)).status).toBe(200);

      const blocked = await challenge(baseUrl);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("ratelimit-policy") ?? blocked.headers.get("ratelimit-limit")).toBeTruthy();
      await expect(blocked.json()).resolves.toEqual({
        error: "Too many authentication attempts. Try again later.",
      });
    });
  });
});

describe("POST /api/users/auth rate limit", () => {
  it("rejects signature attempts beyond the dedicated budget", async () => {
    await withApp(async (baseUrl) => {
      expect((await authenticate(baseUrl)).status).toBe(401);
      expect((await authenticate(baseUrl)).status).toBe(401);

      const blocked = await authenticate(baseUrl);
      expect(blocked.status).toBe(429);
      await expect(blocked.json()).resolves.toEqual({
        error: "Too many authentication attempts. Try again later.",
      });
    });
  });
});

describe("the auth budget is dedicated", () => {
  it("does not spend the other endpoint's budget", async () => {
    await withApp(async (baseUrl) => {
      // Exhaust the challenge budget…
      await challenge(baseUrl);
      await challenge(baseUrl);
      expect((await challenge(baseUrl)).status).toBe(429);

      // …the auth endpoint still has its own.
      expect((await authenticate(baseUrl)).status).toBe(401);
    });
  });

  it("does not apply to non-auth routes", async () => {
    await withApp(async (baseUrl) => {
      await challenge(baseUrl);
      await challenge(baseUrl);
      expect((await challenge(baseUrl)).status).toBe(429);

      // /health is behind the global limiter only. It answers 503 here because
      // the database mock has no $queryRaw, but never the auth limiter's 429.
      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).not.toBe(429);
    });
  });
});
