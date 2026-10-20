/**
 * activity.test.ts
 *
 * The activity summary does money arithmetic, so most of these cases are about
 * the arithmetic being exact and correctly scoped, not about rendering:
 * milestones only count once, funds only count as locked while the escrow is
 * open, and assets are never added together.
 */

import { describe, expect, it } from "vitest";
import { mergeJobs, summarizeActivity } from "./activity";
import type { JobApi } from "./api";

const CLIENT = "GCLIENT00000000000000000000000000000000000000000000000000";

function job(overrides: Partial<JobApi> = {}): JobApi {
  return {
    id: "job-1",
    escrowId: 1,
    title: "Job",
    status: "ACTIVE",
    asset: "XLM",
    totalAmount: 1,
    ...overrides,
  };
}

describe("mergeJobs", () => {
  it("returns one entry per job id across both role lists", () => {
    const merged = mergeJobs(
      [job({ id: "a" }), job({ id: "b" })],
      [job({ id: "b" }), job({ id: "c" })],
    );

    expect(merged.map((j) => j.id).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("summarizeActivity", () => {
  it("counts an open escrow and nothing else for a funded job with no milestones", () => {
    const summary = summarizeActivity({
      asClient: [job({ status: "FUNDED", milestones: [] })],
      asFreelancer: [],
    });

    expect(summary).toMatchObject({
      totalJobs: 1,
      activeEscrows: 1,
      completedJobs: 0,
      asClient: 1,
      asFreelancer: 0,
      released: [],
      locked: [],
    });
  });

  it("treats every open status as an active escrow", () => {
    const summary = summarizeActivity({
      asClient: [job({ id: "f", status: "FUNDED" }), job({ id: "a", status: "ACTIVE" }), job({ id: "d", status: "DISPUTED" })],
      asFreelancer: [],
    });

    expect(summary.activeEscrows).toBe(3);
  });

  it("does not count a completed or refunded job as an open escrow", () => {
    const summary = summarizeActivity({
      asClient: [job({ id: "c", status: "COMPLETED" }), job({ id: "r", status: "REFUNDED" })],
      asFreelancer: [],
    });

    expect(summary.activeEscrows).toBe(0);
    expect(summary.completedJobs).toBe(1);
    expect(summary.totalJobs).toBe(2);
  });

  it("sums released milestones exactly, without float drift", () => {
    const summary = summarizeActivity({
      asFreelancer: [
        job({
          status: "ACTIVE",
          milestones: [
            { amount: "0.1", status: "RELEASED" },
            { amount: "0.2", status: "RELEASED" },
            { amount: "0.3", status: "PENDING" },
          ],
        }),
      ],
      asClient: [],
    });

    // 0.1 + 0.2 as floats is 0.30000000000000004.
    expect(summary.released).toEqual([{ symbol: "XLM", amount: "0.3" }]);
    expect(summary.locked).toEqual([{ symbol: "XLM", amount: "0.3" }]);
  });

  it("keeps each asset's total separate and orders them by symbol", () => {
    const summary = summarizeActivity({
      asClient: [],
      asFreelancer: [
        job({
          id: "xlm",
          asset: "XLM",
          milestones: [{ amount: "2", status: "RELEASED" }],
        }),
        job({
          id: "usdc",
          asset: "USDC",
          milestones: [{ amount: "10.5", status: "RELEASED" }],
        }),
      ],
    });

    expect(summary.released).toEqual([
      { symbol: "USDC", amount: "10.5" },
      { symbol: "XLM", amount: "2" },
    ]);
  });

  it("only counts funds as locked while the escrow is open", () => {
    const unreleased = [{ amount: "4", status: "PENDING" }];

    const active = summarizeActivity({
      asClient: [job({ status: "FUNDED", milestones: unreleased })],
      asFreelancer: [],
    });
    const settled = summarizeActivity({
      asClient: [job({ status: "REFUNDED", milestones: unreleased })],
      asFreelancer: [],
    });

    expect(active.locked).toEqual([{ symbol: "XLM", amount: "4" }]);
    expect(settled.locked).toEqual([]);
  });

  it("totals released funds from both roles", () => {
    const summary = summarizeActivity({
      asClient: [
        job({ id: "c1", milestones: [{ amount: "1.25", status: "RELEASED" }] }),
      ],
      asFreelancer: [
        job({ id: "f1", milestones: [{ amount: "0.75", status: "RELEASED" }] }),
      ],
    });

    expect(summary.released).toEqual([{ symbol: "XLM", amount: "2" }]);
    expect(summary.asClient).toBe(1);
    expect(summary.asFreelancer).toBe(1);
  });

  it("falls back to 7 decimals for an asset it does not know", () => {
    const summary = summarizeActivity({
      asClient: [],
      asFreelancer: [
        job({
          asset: "AQUA",
          milestones: [{ amount: "1.0000001", status: "RELEASED" }],
        }),
      ],
    });

    expect(summary.released).toEqual([{ symbol: "AQUA", amount: "1.0000001" }]);
  });

  it("assumes USDC when the job carries no asset", () => {
    const summary = summarizeActivity({
      asClient: [],
      asFreelancer: [
        job({ asset: undefined, milestones: [{ amount: "3", status: "RELEASED" }] }),
      ],
    });

    expect(summary.released).toEqual([{ symbol: "USDC", amount: "3" }]);
  });

  it("returns an empty summary for an address with no jobs", () => {
    expect(summarizeActivity({ asClient: [], asFreelancer: [] })).toEqual({
      totalJobs: 0,
      activeEscrows: 0,
      completedJobs: 0,
      asClient: 0,
      asFreelancer: 0,
      released: [],
      locked: [],
    });
  });

  it("does not double count a job present in both lists", () => {
    const shared = job({
      id: "shared",
      status: "ACTIVE",
      milestones: [{ amount: "5", status: "PENDING" }],
    });

    const summary = summarizeActivity({ asClient: [shared], asFreelancer: [shared] });

    expect(summary.totalJobs).toBe(1);
    expect(summary.activeEscrows).toBe(1);
    expect(summary.locked).toEqual([{ symbol: "XLM", amount: "5" }]);
  });

  it("tolerates a numeric milestone amount", () => {
    const summary = summarizeActivity({
      asClient: [],
      asFreelancer: [job({ milestones: [{ amount: 1.5, status: "RELEASED" }] })],
    });

    expect(summary.released).toEqual([{ symbol: "XLM", amount: "1.5" }]);
  });

  it("does not mutate or depend on the caller's arrays", () => {
    const asClient = [job({ id: "c" })];
    const asFreelancer = [job({ id: "f", client: { stellarAddress: CLIENT } })];

    summarizeActivity({ asClient, asFreelancer });

    expect(asClient).toHaveLength(1);
    expect(asFreelancer).toHaveLength(1);
    expect(asFreelancer[0].client?.stellarAddress).toBe(CLIENT);
  });
});
