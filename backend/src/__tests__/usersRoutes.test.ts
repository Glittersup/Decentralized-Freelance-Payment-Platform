/**
 * Route tests for `GET /api/users/:address/transactions` — the consolidated
 * on-chain history issue #72 asks for.
 *
 * The database is stubbed (see the `../db` mock), so nothing here needs
 * PostgreSQL. The properties under test are the ones a history view depends on:
 * the events come from the escrows of the user's jobs, the amount is in whole
 * units of the job's asset, and the transaction hash survives to the client so
 * it can build an explorer link.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

const h = vi.hoisted(() => ({
  job: { findMany: vi.fn() },
  chainEvent: { findMany: vi.fn(), count: vi.fn() },
}));

vi.mock("../db", () => ({
  prisma: { job: h.job, chainEvent: h.chainEvent, authNonce: {} },
}));

const USER = "GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B";

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  const { usersRouter } = await import("../routes/users");
  const { errorHandler } = await import("../middleware/errorHandler");
  const { jsonReplacer } = await import("../lib/json");

  const app = express();
  app.set("json replacer", jsonReplacer);
  app.use(express.json());
  app.use("/api/users", usersRouter);
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
  h.job.findMany.mockReset();
  h.job.findMany.mockResolvedValue([]);
  h.chainEvent.findMany.mockReset();
  h.chainEvent.findMany.mockResolvedValue([]);
  h.chainEvent.count.mockReset();
  h.chainEvent.count.mockResolvedValue(0);
});

async function get(path: string) {
  const res = await fetch(`${baseUrl}/api/users${path}`);
  return { status: res.status, body: (await res.json()) as unknown };
}

describe("GET /api/users/:address/transactions", () => {
  it("returns the events on the user's escrows with whole-unit amounts and a tx hash", async () => {
    h.job.findMany.mockResolvedValue([{ escrowId: 7n, asset: "USDC" }]);
    h.chainEvent.findMany.mockResolvedValue([
      {
        id: "evt-42",
        escrowId: 7n,
        action: "milestone_released",
        amount: "3000000",
        txHash: "abc123",
        ledger: 42,
        createdAt: new Date("2026-01-02T03:04:05.000Z"),
      },
    ]);
    h.chainEvent.count.mockResolvedValue(1);

    const res = await get(`/${USER}/transactions`);

    expect(res.status).toBe(200);
    // One query for the user's jobs (both roles) and one for their escrows'
    // events — not one per job.
    expect(h.job.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { client: { stellarAddress: USER } },
          { freelancer: { stellarAddress: USER } },
        ],
      },
      select: { escrowId: true, asset: true },
    });
    expect(h.chainEvent.findMany).toHaveBeenCalledWith({
      where: { escrowId: { in: [7n] } },
      orderBy: [{ ledger: "desc" }, { id: "desc" }],
      skip: 0,
      take: 20,
    });
    expect(res.body).toEqual({
      data: [
        {
          id: "evt-42",
          escrowId: "7",
          action: "milestone_released",
          // 3000000 base units of a 7-decimal asset, not the raw figure.
          amount: "0.3",
          asset: "USDC",
          txHash: "abc123",
          ledger: 42,
          createdAt: "2026-01-02T03:04:05.000Z",
        },
      ],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });
  });

  it("skips events that move nothing, leaving the amount null", async () => {
    h.job.findMany.mockResolvedValue([{ escrowId: 7n, asset: "XLM" }]);
    h.chainEvent.findMany.mockResolvedValue([
      {
        id: "evt-9",
        escrowId: 7n,
        action: "created",
        amount: null,
        txHash: "def456",
        ledger: 9,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    const res = await get(`/${USER}/transactions`);

    const [row] = (res.body as { data: Array<{ amount: string | null; asset: string | null }> }).data;
    expect(row.amount).toBeNull();
    expect(row.asset).toBe("XLM");
  });

  it("returns an empty history without querying events for a user with no escrows", async () => {
    // Jobs that never reached the chain have a null escrowId and cannot own
    // events, so there is nothing to look up.
    h.job.findMany.mockResolvedValue([{ escrowId: null, asset: "USDC" }]);

    const res = await get(`/${USER}/transactions`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
    expect(h.chainEvent.findMany).not.toHaveBeenCalled();
  });

  it("pages past the first 200 events and reports totals", async () => {
    h.job.findMany.mockResolvedValue([{ escrowId: 7n, asset: "USDC" }]);
    h.chainEvent.count.mockResolvedValue(205);
    h.chainEvent.findMany.mockResolvedValue([]);

    const res = await get(`/${USER}/transactions?page=11&limit=20`);

    expect(res.status).toBe(200);
    expect(h.chainEvent.findMany).toHaveBeenCalledWith({
      where: { escrowId: { in: [7n] } },
      orderBy: [{ ledger: "desc" }, { id: "desc" }],
      skip: 200,
      take: 20,
    });
    expect(res.body).toEqual({
      data: [],
      pagination: { page: 11, limit: 20, total: 205, totalPages: 11 },
    });
  });

  it("rejects invalid pagination values", async () => {
    const res = await get(`/${USER}/transactions?page=0&limit=101`);

    expect(res.status).toBe(400);
    expect(h.job.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/users/:address/reminders (#74)", () => {
  const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000);

  /** The job rows `prisma.job.findMany` returns to the reminders route. */
  function openJob(milestones: unknown[]) {
    return {
      id: "job-1",
      title: "Landing page redesign",
      escrowId: 7n,
      client: { stellarAddress: USER },
      freelancer: { stellarAddress: "GFREELANCER" },
      milestones,
    };
  }

  it("returns the milestones that are due soon or overdue", async () => {
    // One Date instance: the route echoes the deadline it was given, and two
    // `hoursFromNow` calls would differ by the milliseconds between them.
    const deadline = hoursFromNow(3);
    h.job.findMany.mockResolvedValue([
      openJob([
        {
          index: 1,
          description: "Ship it",
          amount: "2.5",
          status: "PENDING",
          // Inside the 48h default horizon.
          deadline,
        },
      ]),
    ]);

    const res = await get(`/${USER}/reminders`);

    expect(res.status).toBe(200);
    // A terminal escrow has no deadline left to act on, and a released
    // milestone has already been paid — neither can remind anyone.
    expect(h.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: ["CREATED", "FUNDED", "ACTIVE"] },
          OR: [
            { client: { stellarAddress: USER } },
            { freelancer: { stellarAddress: USER } },
          ],
        },
      }),
    );
    expect(res.body).toEqual([
      {
        jobId: "job-1",
        title: "Landing page redesign",
        escrowId: "7",
        milestoneIndex: 1,
        description: "Ship it",
        amount: "2.5",
        deadline: deadline.toISOString(),
        kind: "due-soon",
        role: "client",
      },
    ]);
  });

  it("honours ?withinHours for callers that want a wider horizon", async () => {
    h.job.findMany.mockResolvedValue([
      openJob([
        {
          index: 0,
          description: null,
          amount: "1",
          status: "PENDING",
          // Beyond the 48h default, inside a week.
          deadline: hoursFromNow(100),
        },
      ]),
    ]);

    expect(await get(`/${USER}/reminders`)).toMatchObject({ body: [] });
    const res = await get(`/${USER}/reminders?withinHours=168`);
    expect((res.body as unknown[]).length).toBe(1);
  });

  it("falls back to the default horizon for an unusable ?withinHours", async () => {
    h.job.findMany.mockResolvedValue([
      openJob([
        { index: 0, description: null, amount: "1", status: "PENDING", deadline: hoursFromNow(10) },
      ]),
    ]);

    const res = await get(`/${USER}/reminders?withinHours=abc`);

    expect((res.body as unknown[]).length).toBe(1);
  });
});
