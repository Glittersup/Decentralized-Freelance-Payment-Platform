/**
 * Route tests for `GET /api/escrow/:escrowId/receipt` (issue #77).
 *
 * The database is stubbed (see the `../db` mock), so nothing here needs
 * PostgreSQL. The properties under test are the endpoint's contract: it builds a
 * receipt from the off-chain job plus the indexed events, refuses an escrow it
 * knows nothing about instead of returning an empty document, and rejects a
 * malformed id.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

const h = vi.hoisted(() => ({
  job: { findUnique: vi.fn() },
  chainEvent: { findMany: vi.fn() },
}));

vi.mock("../db", () => ({ prisma: { job: h.job, chainEvent: h.chainEvent } }));

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  const { escrowRouter } = await import("../routes/escrow");
  const { errorHandler } = await import("../middleware/errorHandler");
  const { jsonReplacer } = await import("../lib/json");

  const app = express();
  app.set("json replacer", jsonReplacer);
  app.use(express.json());
  app.use("/api/escrow", escrowRouter);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  h.job.findUnique.mockReset();
  h.chainEvent.findMany.mockReset();
  h.chainEvent.findMany.mockResolvedValue([]);
});

const receiptJob = () => ({
  id: "job-1",
  escrowId: 7n,
  title: "Landing page redesign",
  description: "A new marketing site",
  status: "ACTIVE",
  asset: "USDC",
  totalAmount: "2.5",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  expiresAt: null,
  client: { stellarAddress: "GCLIENT", displayName: null },
  freelancer: { stellarAddress: "GFREELANCER", displayName: null },
  milestones: [
    {
      index: 0,
      description: "Design",
      amount: "2.5",
      status: "RELEASED",
      deadline: null,
      releasedAt: new Date("2026-02-02T12:00:00.000Z"),
    },
  ],
});

async function get(path: string) {
  const res = await fetch(`${baseUrl}/api/escrow${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/escrow/:escrowId/receipt", () => {
  it("returns the job, its milestones and the indexed events", async () => {
    h.job.findUnique.mockResolvedValue(receiptJob());
    h.chainEvent.findMany.mockResolvedValue([
      {
        id: "evt-1",
        escrowId: 7n,
        action: "milestone_released",
        amount: "25000000",
        txHash: "hash-release",
        ledger: 20,
        createdAt: new Date("2026-02-02T12:00:00.000Z"),
      },
    ]);

    const res = await get("/7/receipt");

    expect(res.status).toBe(200);
    expect(h.job.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { escrowId: 7n } }),
    );
    expect(h.chainEvent.findMany).toHaveBeenCalledWith({ where: { escrowId: 7n } });
    expect(res.body).toMatchObject({
      escrowId: "7",
      job: { id: "job-1", title: "Landing page redesign", totalAmount: "2.5" },
      milestones: [{ index: 0, amount: "2.5", status: "RELEASED" }],
      // Whole units and the transaction link the receipt is checked against.
      events: [{ action: "milestone_released", amount: "2.5", txHash: "hash-release" }],
      totals: { released: "2.5", outstanding: "0" },
    });
  });

  it("refuses an escrow the platform has no job record for", async () => {
    h.job.findUnique.mockResolvedValue(null);

    const res = await get("/7/receipt");

    expect(res.status).toBe(404);
    expect(h.chainEvent.findMany).not.toHaveBeenCalled();
  });

  it("rejects a malformed escrow id instead of querying for it", async () => {
    const res = await get("/not-a-number/receipt");

    expect(res.status).toBe(400);
    expect(h.job.findUnique).not.toHaveBeenCalled();
  });
});
