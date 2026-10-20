import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { jobsRouter } from "../routes/jobs";

const h = vi.hoisted(() => ({
  job: {
    findMany: vi.fn(),
  },
}));

vi.mock("../db", () => ({
  prisma: {
    job: h.job,
  },
}));

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", jobsRouter);
  // The routes reject bad input with AppError; without the handler those reach
  // Express as 500s, which is exactly the failure mode these tests pin down.
  const { errorHandler } = await import("../middleware/errorHandler");
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  h.job.findMany.mockReset();
  h.job.findMany.mockResolvedValue([]);
});

describe("GET /api/jobs search and sort (issue #62)", () => {
  it("filters jobs by keyword q across title and description", async () => {
    await fetch(`${baseUrl}/api/jobs?q=frontend`);

    expect(h.job.findMany).toHaveBeenCalled();
    const callArgs = h.job.findMany.mock.calls[0][0];
    expect(callArgs.where.OR).toEqual([
      { title: { contains: "frontend", mode: "insensitive" } },
      { description: { contains: "frontend", mode: "insensitive" } },
    ]);
  });

  it("applies sorting options", async () => {
    await fetch(`${baseUrl}/api/jobs?sort=amount_desc`);
    let callArgs = h.job.findMany.mock.calls[0][0];
    expect(callArgs.orderBy).toEqual({ totalAmount: "desc" });

    h.job.findMany.mockClear();
    await fetch(`${baseUrl}/api/jobs?sort=oldest`);
    callArgs = h.job.findMany.mock.calls[0][0];
    expect(callArgs.orderBy).toEqual({ createdAt: "asc" });

    h.job.findMany.mockClear();
    await fetch(`${baseUrl}/api/jobs?sort=amount_asc`);
    callArgs = h.job.findMany.mock.calls[0][0];
    expect(callArgs.orderBy).toEqual({ totalAmount: "asc" });
  });

  it("paginates results with skip and take", async () => {
    await fetch(`${baseUrl}/api/jobs?page=3&limit=10`);
    const callArgs = h.job.findMany.mock.calls[0][0];
    expect(callArgs.skip).toBe(20);
    expect(callArgs.take).toBe(10);
  });
});

/**
 * The Dashboard's job browser (issue #9) reads `GET /api/jobs` with a status
 * filter and "load more" pagination. These pin the API contract behind it: the
 * filter reaches Prisma as a real where-clause, the list still carries the
 * relations each row renders (client address, tags, milestones), and a bad
 * filter or page value is a 400 rather than a 500 the UI would report as a
 * server fault.
 */
describe("GET /api/jobs status filter and pagination bounds (issue #9)", () => {
  it("filters by status alone", async () => {
    await fetch(`${baseUrl}/api/jobs?status=COMPLETED`);
    const callArgs = h.job.findMany.mock.calls[0][0];
    expect(callArgs.where.status).toBe("COMPLETED");
  });

  it("serves each row with the relations the Dashboard renders", async () => {
    await fetch(`${baseUrl}/api/jobs`);
    const callArgs = h.job.findMany.mock.calls[0][0];
    expect(callArgs.include).toEqual({
      milestones: true,
      client: true,
      freelancer: true,
    });
  });

  it("defaults to page 1 at the default page size", async () => {
    await fetch(`${baseUrl}/api/jobs`);
    const callArgs = h.job.findMany.mock.calls[0][0];
    expect(callArgs.skip).toBe(0);
    expect(callArgs.take).toBe(20);
  });

  it("rejects a status outside the JobStatus enum with a 400", async () => {
    const res = await fetch(`${baseUrl}/api/jobs?status=NOT_A_STATUS`);
    expect(res.status).toBe(400);
    expect(h.job.findMany).not.toHaveBeenCalled();
  });

  it("rejects a zero or negative page with a 400", async () => {
    for (const page of ["0", "-2"]) {
      h.job.findMany.mockClear();
      const res = await fetch(`${baseUrl}/api/jobs?page=${page}`);
      expect(res.status, `page=${page}`).toBe(400);
      expect(h.job.findMany).not.toHaveBeenCalled();
    }
  });

  it("rejects a non-numeric or oversized limit with a 400", async () => {
    for (const limit of ["abc", "0", "1000"]) {
      h.job.findMany.mockClear();
      const res = await fetch(`${baseUrl}/api/jobs?limit=${limit}`);
      expect(res.status, `limit=${limit}`).toBe(400);
      expect(h.job.findMany).not.toHaveBeenCalled();
    }
  });
});
