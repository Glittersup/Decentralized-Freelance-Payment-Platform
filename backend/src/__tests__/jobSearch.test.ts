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
