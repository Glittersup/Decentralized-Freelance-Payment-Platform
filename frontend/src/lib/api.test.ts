import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticate,
  buildJobsQuery,
  clearAuthToken,
  createDispute,
  createJob,
  fetchMessages,
  fetchRatingsReceived,
  fetchReceipt,
  fetchReminders,
  fetchSavedJobs,
  fetchTransactions,
  fetchUnreadCounts,
  fetchUserJobs,
  linkDisputeId,
  markMessagesRead,
  saveJob,
  sendMessage,
  submitRating,
  unsaveJob,
  submitProposal,
  fetchProposals,
  assignFreelancer,
  type JobApi,
} from "./api";

describe("buildJobsQuery", () => {
  it("omits empty filters", () => {
    expect(buildJobsQuery()).toBe("");
    expect(buildJobsQuery({ status: "", client: "", freelancer: "" })).toBe("");
  });

  it("encodes the status filter", () => {
    expect(buildJobsQuery({ status: "ACTIVE" })).toBe("?status=ACTIVE");
  });

  it("encodes pagination and all filters together", () => {
    const qs = buildJobsQuery({
      status: "COMPLETED",
      client: "GABCD",
      freelancer: "GEFGH",
      tag: "web-development",
      page: 2,
      limit: 10,
    });
    const params = new URLSearchParams(qs);
    expect(params.get("status")).toBe("COMPLETED");
    expect(params.get("client")).toBe("GABCD");
    expect(params.get("freelancer")).toBe("GEFGH");
    expect(params.get("tag")).toBe("web-development");
    expect(params.get("page")).toBe("2");
    expect(params.get("limit")).toBe("10");
    expect(qs.startsWith("?")).toBe(true);
  });

  it("omits the skill-tag filter when it is empty", () => {
    expect(buildJobsQuery({ tag: "" })).toBe("");
    expect(buildJobsQuery({ tag: "devops" })).toBe("?tag=devops");
  });
});

function jobRow(id: string, overrides: Partial<JobApi> = {}): JobApi {
  return {
    id,
    escrowId: null,
    title: `Job ${id}`,
    status: "ACTIVE",
    totalAmountUsdc: "1",
    client: { stellarAddress: "GCLIENT" },
    ...overrides,
  };
}

describe("fetchUserJobs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for both roles and merges them without duplicating a job", async () => {
    // A job where the same address is the client comes back from both filters in
    // the worst case; the history must list it once.
    const both = jobRow("job-1", { freelancer: { stellarAddress: "GADDR" } });
    const fetchMock = vi.fn(async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("freelancer=") ? [jobRow("job-2"), both] : [both, jobRow("job-1")],
        ),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await fetchUserJobs("GADDR");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("client=GADDR");
    expect(fetchMock.mock.calls[1][0]).toContain("freelancer=GADDR");
    expect(jobs.map((j) => j.id).sort()).toEqual(["job-1", "job-2"]);
  });

  it("orders the merged history by createdAt, newest first", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("client=")
            ? [jobRow("old", { createdAt: "2026-01-01T00:00:00.000Z" })]
            : [jobRow("new", { createdAt: "2026-05-01T00:00:00.000Z" })],
        ),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await fetchUserJobs("GADDR");

    expect(jobs.map((j) => j.id)).toEqual(["new", "old"]);
  });
});

describe("fetchRatingsReceived", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the per-address ratings endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "rating-1",
            score: 5,
            comment: null,
            createdAt: "2026-01-03T00:00:00.000Z",
            job: { id: "job-1", title: "Redesign", escrowId: "7", status: "COMPLETED" },
          },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ratings = await fetchRatingsReceived("GADDR");

    expect(ratings[0].score).toBe(5);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/reputation/GADDR/ratings");
  });

  it("throws with the status when the API rejects the read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 })),
    );

    await expect(fetchRatingsReceived("GADDR")).rejects.toThrow(/HTTP 500/);
  });
});

describe("fetchTransactions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the per-address history endpoint and returns the events", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "evt-42",
            escrowId: "7",
            action: "milestone_released",
            amount: "0.3",
            asset: "USDC",
            txHash: "abc123",
            ledger: 42,
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events = await fetchTransactions("GADDR");

    expect(events[0].txHash).toBe("abc123");
    expect(fetchMock.mock.calls[0][0]).toContain("/api/users/GADDR/transactions");
  });

  it("throws with the status when the API rejects the read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 503 })),
    );

    await expect(fetchTransactions("GADDR")).rejects.toThrow(/HTTP 503/);
  });
});

describe("fetchReminders", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the per-address reminders endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            jobId: "job-1",
            title: "Redesign",
            escrowId: "7",
            milestoneIndex: 1,
            description: "Ship it",
            amount: "2.5",
            deadline: "2026-01-13T12:00:00.000Z",
            kind: "due-soon",
            role: "client",
          },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const reminders = await fetchReminders("GADDR");

    expect(reminders[0].kind).toBe("due-soon");
    expect(fetchMock.mock.calls[0][0]).toContain("/api/users/GADDR/reminders");
  });

  it("throws with the status when the API rejects the read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 })),
    );

    await expect(fetchReminders("GADDR")).rejects.toThrow(/HTTP 500/);
  });
});

describe("fetchReceipt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the receipt for the escrow id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ escrowId: "7", milestones: [], events: [] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchReceipt(7n);

    expect(receipt.escrowId).toBe("7");
    expect(fetchMock.mock.calls[0][0]).toContain("/api/escrow/7/receipt");
  });

  it("throws with the status when there is no receipt for the escrow", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 })),
    );

    await expect(fetchReceipt(7n)).rejects.toThrow(/HTTP 404/);
  });
});

describe("authenticate", () => {
  beforeEach(() => {
    // The token cache is module state; each test starts signed out.
    clearAuthToken();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs the challenge nonce and returns the token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ nonce: "nonce-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "jwt-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const signMessage = vi.fn(async () => "sig-base64");

    const token = await authenticate("GCLIENT", signMessage);

    expect(token).toBe("jwt-1");
    expect(signMessage).toHaveBeenCalledWith("nonce-1");
    expect(fetchMock.mock.calls[0][0]).toContain("/api/users/challenge?address=GCLIENT");
    const authBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(authBody).toEqual({
      address: "GCLIENT",
      signature: "sig-base64",
      nonce: "nonce-1",
    });
  });

  it("reuses the token so a page does not prompt the wallet on every read", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ nonce: "nonce-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "jwt-1" }), { status: 200 }))
      // This second challenge must never be reached.
      .mockResolvedValueOnce(new Response(JSON.stringify({ nonce: "nonce-2" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "jwt-2" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const signMessage = vi.fn(async () => "sig-base64");

    expect(await authenticate("GCLIENT", signMessage)).toBe("jwt-1");
    expect(await authenticate("GCLIENT", signMessage)).toBe("jwt-1");

    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one challenge between concurrent callers", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ nonce: "nonce-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "jwt-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const signMessage = vi.fn(async () => "sig-base64");

    const [a, b] = await Promise.all([
      authenticate("GCLIENT", signMessage),
      authenticate("GCLIENT", signMessage),
    ]);

    expect([a, b]).toEqual(["jwt-1", "jwt-1"]);
    expect(signMessage).toHaveBeenCalledTimes(1);
  });

  it("re-challenges when asked for a fresh token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ nonce: "n", token: "jwt" }), { status: 200 }),
    );
    // The challenge and auth responses differ; give each call its own pair.
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ nonce: "n1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "jwt-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ nonce: "n2" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "jwt-2" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const signMessage = vi.fn(async () => "sig");

    expect(await authenticate("GCLIENT", signMessage)).toBe("jwt-1");
    expect(await authenticate("GCLIENT", signMessage, { fresh: true })).toBe("jwt-2");
    expect(signMessage).toHaveBeenCalledTimes(2);
  });
});

describe("messages", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs a job's conversation with a bearer token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ id: "m1", jobId: "job-1", body: "hi" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const messages = await fetchMessages("job-1", "jwt-1");

    expect(messages[0].body).toBe("hi");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/messages/job-1");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-1");
  });

  it("throws with the status when the conversation is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 403 })),
    );

    await expect(fetchMessages("job-1", "jwt-1")).rejects.toThrow(/HTTP 403/);
  });

  it("POSTs a message body", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "m2", jobId: "job-1", body: "hello" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const sent = await sendMessage("job-1", "hello", "jwt-1");

    expect(sent.id).toBe("m2");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/messages/job-1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ body: "hello" });
  });

  it("POSTs a read receipt and returns how many messages changed", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ markedRead: 2 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await markMessagesRead("job-1", "jwt-1")).toBe(2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/messages/job-1/read");
    expect(init.method).toBe("POST");
  });

  it("GETs the unread counts", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ total: 3, byJob: [{ jobId: "job-1", count: 3 }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const counts = await fetchUnreadCounts("jwt-1");

    expect(counts.total).toBe(3);
    expect(counts.byJob[0]).toEqual({ jobId: "job-1", count: 3 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/messages/unread");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-1");
  });
});

describe("bookmarks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs the saved jobs with a bearer token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ id: "job-1", title: "Bookmarked" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const jobs = await fetchSavedJobs("jwt-1");

    expect(jobs[0].id).toBe("job-1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/jobs/saved");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-1");
  });

  it("POSTs a bookmark", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await saveJob("job-1", "jwt-1");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/jobs/job-1/save");
    expect(init.method).toBe("POST");
  });

  it("DELETEs a bookmark", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await unsaveJob("job-1", "jwt-1");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/jobs/job-1/save");
    expect(init.method).toBe("DELETE");
  });

  it("throws with the status when a bookmark is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 401 })),
    );

    await expect(saveJob("job-1", "stale")).rejects.toThrow(/HTTP 401/);
  });
});

describe("createJob", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the job with the chosen asset and a bearer token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "job-1" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const job = await createJob(
      {
        title: "Redesign",
        description: "A longer description",
        asset: "XLM",
        milestones: [{ amountUsdc: 1.5 }],
      },
      "jwt-1",
    );

    expect(job.id).toBe("job-1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/jobs");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-1");
    expect(JSON.parse(init.body as string).asset).toBe("XLM");
  });
});

describe("submitRating", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the rating with a bearer token and returns the row + xdr", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          rating: { id: "rating-1", jobId: "job-1", score: 5, comment: "great work" },
          xdr: "AAAA",
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await submitRating(
      { jobId: "job-1", rateeAddress: "GRATEE", score: 5, comment: "great work" },
      "jwt-1",
    );

    expect(res.rating.id).toBe("rating-1");
    expect(res.xdr).toBe("AAAA");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/reputation");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-1");
    expect(JSON.parse(init.body as string)).toEqual({
      jobId: "job-1",
      rateeAddress: "GRATEE",
      score: 5,
      comment: "great work",
    });
  });

  it("throws with the status when the API rejects the rating", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 400 })),
    );

    await expect(
      submitRating({ jobId: "job-1", rateeAddress: "GRATEE", score: 5 }, "jwt-1"),
    ).rejects.toThrow(/HTTP 400/);
  });
});

describe("createDispute", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the job id and the reason with a bearer token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          dispute: { id: "dispute-1", jobId: "job-1", onChainId: null, status: "RAISED", reason: "late" },
          xdr: "AAAA",
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await createDispute({ jobId: "job-1", reason: "late" }, "jwt-1");

    // The row exists before the chain knows about the dispute, so its id is what
    // `linkDisputeId` has to carry forward.
    expect(res.dispute.id).toBe("dispute-1");
    expect(res.dispute.onChainId).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/disputes");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-1");
    expect(JSON.parse(init.body as string)).toEqual({ jobId: "job-1", reason: "late" });
  });

  it("throws with the status when the API refuses to record it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 403 })),
    );

    await expect(createDispute({ jobId: "job-1", reason: "late" }, "jwt-1")).rejects.toThrow(
      /HTTP 403/,
    );
  });
});

describe("linkDisputeId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the on-chain id returned by dispute.raise as a number", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: "dispute-1", jobId: "job-1", onChainId: "3", status: "RAISED", reason: "late" }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    // The contract returns a bigint; the route validates an integer, and the
    // column is a BigInt, so it must not be sent as a string.
    const updated = await linkDisputeId("dispute-1", 3n, "jwt-1");

    expect(updated.onChainId).toBe("3");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/disputes/dispute-1/sync");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ onChainId: 3 });
  });

  it("throws with the status when the id cannot be recorded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 403 })),
    );

    await expect(linkDisputeId("dispute-1", 3n, "jwt-1")).rejects.toThrow(/HTTP 403/);
  });
});

describe("submitProposal and proposals API (Issue #63)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submits proposal successfully with auth token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "prop-1",
          jobId: "job-1",
          coverLetter: "My cover letter",
          proposedRate: "100",
          status: "PENDING",
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitProposal(
      "job-1",
      { coverLetter: "My cover letter", proposedRate: "100" },
      "jwt-1",
    );

    expect(result.id).toBe("prop-1");
    expect(result.status).toBe("PENDING");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/jobs/job-1/proposals");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-1");
    expect(JSON.parse(init.body as string)).toEqual({
      coverLetter: "My cover letter",
      proposedRate: "100",
    });
  });

  it("fetches proposals for a job", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ id: "prop-1", status: "PENDING" }]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const list = await fetchProposals("job-1");
    expect(list).toHaveLength(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/jobs/job-1/proposals");
  });

  it("assigns freelancer to a job", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "job-1", status: "CREATED", freelancerId: "free-1" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const updated = await assignFreelancer("job-1", "GABCDEF", "jwt-1");
    expect(updated.id).toBe("job-1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/jobs/job-1/assign");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ freelancerAddress: "GABCDEF" });
  });
});

