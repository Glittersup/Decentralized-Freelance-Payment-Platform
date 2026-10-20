import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Hoisted so the vi.mock factories below can reference them.
const h = vi.hoisted(() => ({
  escrow: {
    getEscrow: vi.fn(),
    releaseMilestone: vi.fn(),
    openDispute: vi.fn(),
    reclaimDisputed: vi.fn(),
    reclaimExpired: vi.fn(),
    submitRating: vi.fn(),
    getDisputeDeadline: vi.fn(),
    isPending: vi.fn(() => false),
    hasPendingWrite: vi.fn(() => false),
    error: null as string | null,
    lastFailure: null as { kind: string; code: number | null } | null,
  },
  wallet: {
    publicKey: "GCLIENT" as string | null,
    connect: vi.fn(async () => "GCLIENT"),
    signMessage: vi.fn(async () => "sig"),
  },
  authenticate: vi.fn(async () => "jwt-1"),
  fetchJobs: vi.fn(async () => [] as unknown[]),
  fetchJob: vi.fn(async () => null as unknown),
  uploadJobMilestoneDeliverable: vi.fn(),
  recordRating: vi.fn(async () => ({ rating: {}, xdr: "x" })),
  createDispute: vi.fn(),
  linkDisputeId: vi.fn(),
  // Mounted for a participant once the escrow id resolves to a job id (#64).
  fetchMessages: vi.fn(async () => [] as unknown[]),
  sendMessage: vi.fn(),
  markMessagesRead: vi.fn(async () => 0),
}));

vi.mock("react-router-dom", () => ({
  useParams: () => ({ id: "7" }),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("../hooks/wallet-context", () => ({ useWallet: () => h.wallet }));
// Fiat estimates (#76) read an external price feed; no rate in these tests.
vi.mock("../lib/prices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/prices")>()),
  getFiatRates: async () => ({}),
}));
vi.mock("../hooks/useEscrow", () => ({ useEscrow: () => h.escrow }));
vi.mock("../lib/stellar", () => ({
  explorerTxUrl: (hash: string) => `https://stellar.expert/tx/${hash}`,
}));
vi.mock("../lib/api", () => ({
  authenticate: h.authenticate,
  fetchJobs: h.fetchJobs,
  fetchJob: h.fetchJob,
  uploadJobMilestoneDeliverable: h.uploadJobMilestoneDeliverable,
  submitRating: h.recordRating,
  createDispute: h.createDispute,
  linkDisputeId: h.linkDisputeId,
  fetchMessages: h.fetchMessages,
  sendMessage: h.sendMessage,
  markMessagesRead: h.markMessagesRead,
}));

import { ContractReadError } from "../lib/errors";
import JobDetail from "./JobDetail";

const CLIENT = "GCLIENT";
const FREELANCER = "GFREELANCER";

const COMPLETED = {
  client: CLIENT,
  freelancer: FREELANCER,
  token: "CTOKEN",
  total_amount: 20_000_000n,
  milestones: [
    { amount: 20_000_000n, released: true, released_amount: 20_000_000n, deadline: 0n },
  ],
  status: "Completed",
  created_at: 0n,
  expiry: 0n,
};

/** A disputed escrow with one milestone still unreleased. */
const DISPUTED = {
  ...COMPLETED,
  status: "Disputed",
  milestones: [
    { amount: 20_000_000n, released: false, released_amount: 0n, deadline: 0n },
  ],
};

/**
 * A funded, undisputed escrow with one milestone still to release — the only
 * state a dispute can be opened from.
 *
 * `BigInt(id)` on a non-numeric `:id` is #106 (tracked separately): the guard
 * that should catch it is unreachable while the conversion throws, so nothing
 * here asserts the crash.
 */
const ACTIVE = {
  ...COMPLETED,
  status: "Active",
  milestones: [
    { amount: 20_000_000n, released: false, released_amount: 0n, deadline: 0n },
  ],
};

/** Current unix seconds — the contract compares against its own ledger clock. */
const nowSeconds = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  h.wallet.publicKey = CLIENT;
  h.escrow.getEscrow.mockReset();
  h.escrow.getEscrow.mockResolvedValue(COMPLETED);
  h.escrow.submitRating.mockReset();
  h.escrow.submitRating.mockResolvedValue({ hash: "HASH", result: undefined });
  h.escrow.reclaimDisputed.mockReset();
  h.escrow.reclaimDisputed.mockResolvedValue({ hash: "RECLAIMHASH", result: undefined });
  h.escrow.reclaimExpired.mockReset();
  h.escrow.reclaimExpired.mockResolvedValue({ hash: "RECLAIMEXPIREDHASH", result: undefined });
  h.escrow.getDisputeDeadline.mockReset();
  h.escrow.getDisputeDeadline.mockResolvedValue(BigInt(nowSeconds() + 3 * 86_400));
  h.escrow.isPending.mockReset();
  h.escrow.isPending.mockReturnValue(false);
  h.escrow.hasPendingWrite.mockReset();
  h.escrow.hasPendingWrite.mockReturnValue(false);
  h.escrow.error = null;
  h.escrow.lastFailure = null;
  h.fetchJobs.mockReset();
  h.fetchJobs.mockResolvedValue([]);
  h.authenticate.mockClear();
  h.recordRating.mockClear();
  h.escrow.openDispute.mockReset();
  h.escrow.openDispute.mockResolvedValue({ hash: "DISPUTEHASH", disputeId: 3n });
  h.createDispute.mockReset();
  h.createDispute.mockResolvedValue({
    dispute: { id: "dispute-1", jobId: "job-1", onChainId: null, status: "RAISED", reason: "x" },
    xdr: "open-dispute-xdr",
  });
  h.linkDisputeId.mockReset();
  h.linkDisputeId.mockResolvedValue({ id: "dispute-1", onChainId: 3 });
});

afterEach(() => cleanup());

/** Render the page and wait for the rating form to appear. */
async function renderCompleted(): Promise<void> {
  render(<JobDetail />);
  await screen.findByRole("heading", { name: "Rate your counterparty" });
}

function submitRatingForm(): void {
  const form = screen
    .getByRole("button", { name: "Submit rating" })
    .closest("form");
  if (!form) throw new Error("rating form not found");
  fireEvent.submit(form);
}

/** The same escrow once its only milestone has been paid out. */
const ACTIVE_RELEASED = {
  ...ACTIVE,
  milestones: [
    { amount: 20_000_000n, released: true, released_amount: 20_000_000n, deadline: 0n },
  ],
};

describe("JobDetail actions", () => {
  beforeEach(() => {
    h.escrow.releaseMilestone.mockReset();
    h.escrow.releaseMilestone.mockResolvedValue({ hash: "RELEASEHASH", result: undefined });
    h.escrow.openDispute.mockReset();
    h.escrow.openDispute.mockResolvedValue({ hash: "DISPUTEHASH", result: undefined });
  });

  it("releases a milestone for the client and links the transaction", async () => {
    h.escrow.getEscrow.mockResolvedValue(ACTIVE);
    render(<JobDetail />);

    fireEvent.click(await screen.findByRole("button", { name: "Release" }));

    await waitFor(() => expect(h.escrow.releaseMilestone).toHaveBeenCalledWith(7n, 0));
    const tx = await screen.findByRole("link", { name: /RELEASE/ });
    expect(tx.getAttribute("href")).toBe("https://stellar.expert/tx/RELEASEHASH");
  });

  it("does not offer a release to the freelancer", async () => {
    // Only the client can move funds out of escrow; the contract enforces it, but
    // the button should never be shown either.
    h.wallet.publicKey = FREELANCER;
    h.escrow.getEscrow.mockResolvedValue(ACTIVE);
    render(<JobDetail />);

    await screen.findByText("Milestones");
    expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
  });

  it("does not offer a release once the job is no longer active", async () => {
    h.escrow.getEscrow.mockResolvedValue(COMPLETED);
    render(<JobDetail />);

    await screen.findByText("Milestones");
    expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
  });

  it("does not offer a release for an already released milestone", async () => {
    h.escrow.getEscrow.mockResolvedValue(ACTIVE_RELEASED);
    render(<JobDetail />);

    await screen.findByText("Milestones");
    expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
  });

  it("freezes every action while a dispute is open", async () => {
    h.escrow.getEscrow.mockResolvedValue(DISPUTED);
    h.escrow.getDisputeDeadline.mockResolvedValue(BigInt(nowSeconds() + 3 * 86_400));
    render(<JobDetail />);

    await screen.findByText(/frozen pending arbitration/i);
    expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open dispute" })).toBeNull();
  });

  it("opens a dispute for a participant while the escrow is active", async () => {
    h.escrow.getEscrow.mockResolvedValue(ACTIVE);
    render(<JobDetail />);

    await screen.findByRole("button", { name: "Open dispute" });
    // The action is gated on a reason the panel can rule on (#86), so the
    // participant has to give one before the contract call can happen.
    const reason = "The milestone was never delivered";
    fireEvent.change(screen.getByLabelText(/Reason for the dispute/), {
      target: { value: reason },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open dispute" }));

    await waitFor(() => expect(h.escrow.openDispute).toHaveBeenCalledWith(7n, reason));
  });

  it("does not offer a dispute to a wallet with no stake in the job", async () => {
    h.wallet.publicKey = "GSTRANGER";
    h.escrow.getEscrow.mockResolvedValue(ACTIVE);
    render(<JobDetail />);

    await screen.findByText("Milestones");
    expect(screen.queryByRole("button", { name: "Open dispute" })).toBeNull();
  });
});

describe("JobDetail load state", () => {
  it("renders the escrow for a visitor with no wallet connected", async () => {
    // #108: a shared /jobs/:id link is a public read, so it must not wait for
    // Freighter (or for a funded wallet) to show the job.
    h.wallet.publicKey = null;
    h.escrow.getEscrow.mockResolvedValue(ACTIVE);
    render(<JobDetail />);

    expect(await screen.findByText("Milestones")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    // The wallet prompt stays, but only for the actions the page offers.
    expect(screen.getByText(/to act on this job/)).toBeTruthy();
    expect(screen.getByText(/Reading it needs no wallet/)).toBeTruthy();
    expect(h.wallet.connect).not.toHaveBeenCalled();
  });

  it("says the job was not found instead of blaming the id", async () => {
    h.escrow.getEscrow.mockRejectedValue(
      new ContractReadError("not-found", "That record was not found."),
    );
    render(<JobDetail />);

    expect((await screen.findByRole("alert")).textContent).toMatch(/check the link/);
    expect(screen.queryByText(/is the id correct/i)).toBeNull();
  });

  it("reports a network problem as a network problem, with a retry", async () => {
    h.escrow.getEscrow.mockRejectedValue(
      new ContractReadError("unavailable", "Failed to fetch"),
    );
    render(<JobDetail />);

    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't reach Stellar/);
    expect(screen.queryByText(/check the link/)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("shows the error the hook surfaced", async () => {
    h.escrow.error = "Could not reach the network.";
    render(<JobDetail />);

    expect((await screen.findByRole("alert")).textContent).toBe("Could not reach the network.");
  });
});

describe("JobDetail rating", () => {
  it("offers the participant a rating form on a completed job", async () => {
    await renderCompleted();

    expect(screen.getAllByRole("radio")).toHaveLength(5);
    // No score chosen yet, so the form cannot be submitted.
    const submit = screen.getByRole("button", { name: "Submit rating" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("submits the rating on-chain and links the hash and the counterparty profile", async () => {
    await renderCompleted();

    fireEvent.click(screen.getByRole("radio", { name: /4/ }));
    submitRatingForm();

    await waitFor(() =>
      expect(h.escrow.submitRating).toHaveBeenCalledWith(7n, FREELANCER, 4),
    );
    await screen.findByText(/your rating was submitted/i);
    // The form is gone once the wallet has rated.
    expect(screen.queryByRole("button", { name: "Submit rating" })).toBeNull();

    const profile = screen.getByRole("link", { name: /View reputation/ });
    expect(profile.getAttribute("href")).toBe(`/profile/${FREELANCER}`);
    const tx = screen.getByRole("link", { name: /HASH/ });
    expect(tx.getAttribute("href")).toBe("https://stellar.expert/tx/HASH");
  });

  it("lets the freelancer rate the client", async () => {
    h.wallet.publicKey = FREELANCER;
    await renderCompleted();

    fireEvent.click(screen.getByRole("radio", { name: /5/ }));
    submitRatingForm();

    await waitFor(() => expect(h.escrow.submitRating).toHaveBeenCalledWith(7n, CLIENT, 5));
  });

  it("persists the optional comment off-chain after the rating lands", async () => {
    h.fetchJobs.mockResolvedValue([
      { id: "job-1", escrowId: 7, title: "t", status: "COMPLETED", totalAmount: 1 },
    ]);
    await renderCompleted();

    fireEvent.click(screen.getByRole("radio", { name: /5/ }));
    fireEvent.change(screen.getByLabelText(/Comment/), {
      target: { value: "great work" },
    });
    submitRatingForm();

    await waitFor(() =>
      expect(h.recordRating).toHaveBeenCalledWith(
        { jobId: "job-1", rateeAddress: FREELANCER, score: 5, comment: "great work" },
        "jwt-1",
      ),
    );
  });

  it("hides the form and explains when this wallet has already rated", async () => {
    h.escrow.lastFailure = { kind: "rate", code: 5 };
    render(<JobDetail />);

    await screen.findByText(/already rated this job/i);
    expect(screen.queryByRole("button", { name: "Submit rating" })).toBeNull();
  });

  it("does not offer a rating before the job completes", async () => {
    h.escrow.getEscrow.mockResolvedValue({ ...COMPLETED, status: "Active" });
    render(<JobDetail />);

    await screen.findByText("Milestones");
    expect(screen.queryByRole("button", { name: "Submit rating" })).toBeNull();
  });

  it("does not offer a rating to a wallet that is not a participant", async () => {
    h.wallet.publicKey = "GSTRANGER";
    render(<JobDetail />);

    await screen.findByText("Milestones");
    expect(screen.queryByRole("button", { name: "Submit rating" })).toBeNull();
  });
});

describe("JobDetail dispute timelock", () => {
  it("disables the reclaim before the deadline and shows the time remaining", async () => {
    h.escrow.getEscrow.mockResolvedValue(DISPUTED);
    h.escrow.getDisputeDeadline.mockResolvedValue(BigInt(nowSeconds() + 3 * 86_400));

    render(<JobDetail />);

    const button = await screen.findByRole("button", { name: "Reclaim after timeout" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Reclaimable only after/i)).toBeTruthy();
    expect(screen.getByText(/left\)/i)).toBeTruthy();
    expect(h.escrow.reclaimDisputed).not.toHaveBeenCalled();
  });

  it("enables the reclaim for the client once the deadline passes and submits it", async () => {
    h.escrow.getEscrow.mockResolvedValue(DISPUTED);
    h.escrow.getDisputeDeadline.mockResolvedValue(BigInt(nowSeconds() - 10));

    render(<JobDetail />);

    const button = await screen.findByRole("button", { name: "Reclaim after timeout" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/timelock has passed/i)).toBeTruthy();

    fireEvent.click(button);

    await waitFor(() => expect(h.escrow.reclaimDisputed).toHaveBeenCalledWith(7n));
    // The transaction is linked on the explorer like every other write.
    const tx = await screen.findByRole("link", { name: /RECLAIM/ });
    expect(tx.getAttribute("href")).toBe("https://stellar.expert/tx/RECLAIMHASH");
  });

  it("shows the frozen notice but no reclaim action to a non-client", async () => {
    h.wallet.publicKey = FREELANCER;
    h.escrow.getEscrow.mockResolvedValue(DISPUTED);
    h.escrow.getDisputeDeadline.mockResolvedValue(BigInt(nowSeconds() - 10));

    render(<JobDetail />);

    await screen.findByText(/frozen pending arbitration/i);
    expect(screen.queryByRole("button", { name: "Reclaim after timeout" })).toBeNull();
  });
});

describe("JobDetail expired escrow reclaim (#82)", () => {
  /** An Active escrow whose expiry has passed. */
  const expired = {
    ...ACTIVE,
    expiry: BigInt(nowSeconds() - 3600), // expired 1 hour ago
  };

  it("shows a reclaim button for the client on an expired active escrow", async () => {
    h.escrow.getEscrow.mockResolvedValue(expired);
    h.wallet.publicKey = CLIENT;
    render(<JobDetail />);

    await screen.findByRole("button", { name: /Reclaim expired escrow/i });
  });

  it("does not show a reclaim button for a non-client on an expired escrow", async () => {
    h.escrow.getEscrow.mockResolvedValue(expired);
    h.wallet.publicKey = FREELANCER;
    render(<JobDetail />);

    await screen.findByText("Milestones");
    expect(screen.queryByRole("button", { name: /Reclaim expired escrow/i })).toBeNull();
  });

  it("does not show a reclaim button for an active escrow that has not expired", async () => {
    h.escrow.getEscrow.mockResolvedValue(ACTIVE);
    h.wallet.publicKey = CLIENT;
    render(<JobDetail />);

    await screen.findByText("Milestones");
    expect(screen.queryByRole("button", { name: /Reclaim expired escrow/i })).toBeNull();
  });

  it("submits reclaim_expired when the client clicks the button", async () => {
    h.escrow.getEscrow.mockResolvedValue(expired);
    h.wallet.publicKey = CLIENT;
    render(<JobDetail />);

    const button = await screen.findByRole("button", { name: /Reclaim expired escrow/i });
    fireEvent.click(button);

    await waitFor(() => expect(h.escrow.reclaimExpired).toHaveBeenCalledWith(7n));
    const tx = await screen.findByRole("link", { name: /RECLAIMEXPIR/ });
    expect(tx.getAttribute("href")).toBe("https://stellar.expert/tx/RECLAIMEXPIREDHASH");
  });

  it("disables the reclaim button while a reclaim is in flight", async () => {
    h.escrow.getEscrow.mockResolvedValue(expired);
    // Simulate a pending reclaim by making isPending return true for reclaim:7
    h.escrow.isPending.mockReturnValue(true);
    h.wallet.publicKey = CLIENT;
    render(<JobDetail />);

    // The button shows "Reclaiming…" while pending, so search for that.
    const button = await screen.findByRole("button", { name: /Reclaiming/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("does not show a reclaim button for a non-active escrow", async () => {
    h.escrow.getEscrow.mockResolvedValue(COMPLETED);
    h.wallet.publicKey = CLIENT;
    render(<JobDetail />);

    await screen.findByText("Milestones");
    expect(screen.queryByRole("button", { name: /Reclaim expired escrow/i })).toBeNull();
  });
});

describe("JobDetail receipt link (#77)", () => {
  it("links to the escrow's printable receipt", async () => {
    render(<JobDetail />);

    const link = await screen.findByRole("link", { name: "View receipt" });
    expect(link.getAttribute("href")).toBe("/jobs/7/receipt");
  });
});

describe("JobDetail milestone deadlines (#74)", () => {
  /** An Active escrow whose only milestone has the given deadline. */
  const activeWithDeadline = (deadline: bigint) => ({
    ...ACTIVE,
    milestones: [
      { amount: 20_000_000n, released: false, released_amount: 0n, deadline },
    ],
  });

  it("flags an unreleased milestone whose deadline has passed", async () => {
    h.escrow.getEscrow.mockResolvedValue(activeWithDeadline(BigInt(nowSeconds() - 60)));
    render(<JobDetail />);

    // The reminder is visible where the work is released, not only on the
    // Dashboard panel.
    expect(await screen.findByText(/\(overdue\)/)).toBeTruthy();
  });

  it("shows the time left on a deadline still ahead", async () => {
    h.escrow.getEscrow.mockResolvedValue(activeWithDeadline(BigInt(nowSeconds() + 4 * 3_600)));
    render(<JobDetail />);

    expect(await screen.findByText(/left\)/)).toBeTruthy();
    expect(screen.queryByText(/\(overdue\)/)).toBeNull();
  });
});

describe("JobDetail opening a dispute", () => {
  const REASON = "The final milestone was never delivered";

  /** Render an Active escrow and wait for the dispute form. */
  async function renderActive(): Promise<void> {
    h.escrow.getEscrow.mockResolvedValue(ACTIVE);
    render(<JobDetail />);
    await screen.findByRole("button", { name: "Open dispute" });
  }

  function disputeForm(): HTMLFormElement {
    const form = screen.getByRole("button", { name: "Open dispute" }).closest("form");
    if (!form) throw new Error("dispute form not found");
    return form;
  }

  it("withholds the action until the reason is one the panel can act on", async () => {
    await renderActive();

    const submit = screen.getByRole("button", { name: "Open dispute" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    // Submitting anyway must not freeze the escrow: the handler re-checks, so a
    // form that bypassed the button (or a future refactor of it) cannot raise a
    // dispute with a reason too short for the API to accept.
    fireEvent.change(screen.getByLabelText(/Reason for the dispute/), {
      target: { value: "too short" },
    });
    fireEvent.submit(disputeForm());
    expect(h.escrow.openDispute).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Reason for the dispute/), {
      target: { value: REASON },
    });
    expect((screen.getByRole("button", { name: "Open dispute" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("freezes the escrow, raises the dispute, then records the reason and the id", async () => {
    h.fetchJobs.mockResolvedValue([
      { id: "job-1", escrowId: 7, title: "t", status: "ACTIVE", totalAmount: 1 },
    ]);
    await renderActive();

    fireEvent.change(screen.getByLabelText(/Reason for the dispute/), {
      target: { value: REASON },
    });
    fireEvent.submit(disputeForm());

    // One user action, two contract calls: open_dispute freezes the escrow and
    // raise mints the dispute the panel rules on (#86).
    await waitFor(() => expect(h.escrow.openDispute).toHaveBeenCalledWith(7n, REASON));
    // The reason and the returned id land on the same off-chain row.
    await waitFor(() =>
      expect(h.createDispute).toHaveBeenCalledWith(
        { jobId: "job-1", reason: REASON },
        "jwt-1",
      ),
    );
    await waitFor(() => expect(h.linkDisputeId).toHaveBeenCalledWith("dispute-1", 3n, "jwt-1"));

    const tx = await screen.findByRole("link", { name: /DISPUTEHASH/ });
    expect(tx.getAttribute("href")).toBe("https://stellar.expert/tx/DISPUTEHASH");
  });

  it("says the dispute is on-chain when the off-chain record could not be saved", async () => {
    h.fetchJobs.mockResolvedValue([
      { id: "job-1", escrowId: 7, title: "t", status: "ACTIVE", totalAmount: 1 },
    ]);
    h.createDispute.mockRejectedValue(new Error("Could not record the dispute (HTTP 500)"));
    await renderActive();

    fireEvent.change(screen.getByLabelText(/Reason for the dispute/), {
      target: { value: REASON },
    });
    fireEvent.submit(disputeForm());

    // The money is already frozen, so the failure must not read as "nothing
    // happened" — only as "the reason was not stored".
    await screen.findByText(/dispute is on-chain, but its record was not saved/i);
    await screen.findByRole("link", { name: /DISPUTEHASH/ });
  });

  it("still records the dispute when the job has no off-chain record yet", async () => {
    // `findJobIdByEscrow` returns null: the API has no row to attach to, and the
    // on-chain dispute is unaffected.
    h.fetchJobs.mockResolvedValue([]);
    await renderActive();

    fireEvent.change(screen.getByLabelText(/Reason for the dispute/), {
      target: { value: REASON },
    });
    fireEvent.submit(disputeForm());

    await waitFor(() => expect(h.escrow.openDispute).toHaveBeenCalledWith(7n, REASON));
    expect(h.createDispute).not.toHaveBeenCalled();
    await screen.findByText(/no off-chain record, so the reason was not stored/i);
  });
});

describe("Milestone Deliverables (Issue #65)", () => {
  beforeEach(() => {
    h.fetchJobs.mockReset();
    h.fetchJob.mockReset();
    h.uploadJobMilestoneDeliverable.mockReset();
    h.wallet.publicKey = CLIENT;
  });

  it("displays deliverables for client to review before releasing", async () => {
    h.escrow.getEscrow.mockResolvedValue(ACTIVE);
    h.fetchJobs.mockResolvedValue([{ id: "job-1", escrowId: 7 }]);
    h.fetchJob.mockResolvedValue({
      id: "job-1",
      milestones: [
        {
          id: "m-1",
          index: 0,
          deliverables: [
            {
              id: "d-1",
              milestoneId: "m-1",
              fileName: "final_design.pdf",
              fileUrl: "https://example.com/final_design.pdf",
              fileSize: 20480,
              description: "Final PDF export",
            },
          ],
        },
      ],
    });

    render(<JobDetail />);

    expect(await screen.findByText("final_design.pdf")).toBeTruthy();
    expect(screen.getByText(/20.0 KB/)).toBeTruthy();
    expect(screen.getByText(/Final PDF export/)).toBeTruthy();
    // Client sees the Release button available
    expect(screen.getByRole("button", { name: "Release" })).toBeTruthy();
  });

  it("shows Attach Deliverable action for the freelancer", async () => {
    h.wallet.publicKey = FREELANCER;
    h.escrow.getEscrow.mockResolvedValue(ACTIVE);
    h.fetchJobs.mockResolvedValue([{ id: "job-1", escrowId: 7 }]);

    render(<JobDetail />);

    const attachBtn = await screen.findByRole("button", { name: "Attach Deliverable" });
    expect(attachBtn).toBeTruthy();

    fireEvent.click(attachBtn);
    expect(screen.getByText("Select File")).toBeTruthy();
  });
});

