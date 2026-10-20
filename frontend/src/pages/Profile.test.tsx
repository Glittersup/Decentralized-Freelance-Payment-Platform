/**
 * Profile.test.tsx
 *
 * The reputation view is read-only, but it is the page a client checks before
 * paying someone. The states that matter are: the aggregate, the job history and
 * the individual ratings behind it (issue #69), the indexed on-chain history for
 * the address's escrows (issue #72), an address with nothing yet, and a read that
 * failed. The wallet, the SDK and the API client are mocked — no network, no
 * Freighter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  /** The route param, so a test can point the page at another address. */
  address: "GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B",
  escrow: {
    getReputation: vi.fn(),
    isPending: vi.fn((kind?: string) => kind === "reputation"),
    error: null as string | null,
  },
  wallet: {
    publicKey: "GVIEWER" as string | null,
    connect: vi.fn(async () => "GVIEWER"),
    signMessage: vi.fn(async () => "mock-signature"),
  },
  api: {
    fetchUserProfile: vi.fn(),
    updateUserProfile: vi.fn(),
    authenticate: vi.fn(async () => "test-jwt-token"),
    fetchUserJobs: vi.fn(),
    fetchRatingsReceived: vi.fn(),
    fetchTransactions: vi.fn(),
  },
}));

vi.mock("react-router-dom", () => ({
  useParams: () => ({ address: h.address }),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("../hooks/wallet-context", () => ({ useWallet: () => h.wallet }));
vi.mock("../hooks/useEscrow", () => ({ useEscrow: () => h.escrow }));
vi.mock("../lib/api", () => ({
  fetchUserJobs: h.api.fetchUserJobs,
  fetchRatingsReceived: h.api.fetchRatingsReceived,
  fetchTransactions: h.api.fetchTransactions,
  fetchUserProfile: h.api.fetchUserProfile,
  updateUserProfile: h.api.updateUserProfile,
  authenticate: h.api.authenticate,
}));

import { ContractReadError } from "../lib/errors";
import Profile from "./Profile";
import type { JobApi, ReceivedRatingApi, TransactionApi } from "../lib/api";

const ADDRESS = h.address;

/** The rendered summary line, whatever markup it is spread across. */
const summary = (text: string) =>
  screen.findByText((_content, element) => element?.textContent === text);

function job(overrides: Partial<JobApi> = {}): JobApi {
  return {
    id: "job-1",
    escrowId: 7,
    title: "Landing page redesign",
    status: "COMPLETED",
    asset: "USDC",
    totalAmount: "2.5",
    createdAt: "2026-01-02T00:00:00.000Z",
    client: { stellarAddress: ADDRESS },
    freelancer: { stellarAddress: "GFREELANCER" },
    ...overrides,
  };
}

function rating(overrides: Partial<ReceivedRatingApi> = {}): ReceivedRatingApi {
  return {
    id: "rating-1",
    score: 5,
    comment: null,
    createdAt: "2026-01-03T00:00:00.000Z",
    job: { id: "job-1", title: "Landing page redesign", escrowId: 7, status: "COMPLETED" },
    rater: { stellarAddress: "GFREELANCER" },
    ...overrides,
  };
}

function transaction(overrides: Partial<TransactionApi> = {}): TransactionApi {
  return {
    id: "evt-42",
    escrowId: "7",
    action: "milestone_released",
    amount: "0.3",
    asset: "USDC",
    txHash: "abc123def4567890",
    ledger: 42,
    createdAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  h.escrow.getReputation.mockReset();
  // A public read resolves to the contract's aggregate, or rejects with a typed
  // `ContractReadError` (it is never a silent `undefined`).
  h.escrow.getReputation.mockResolvedValue({ total_score: 0n, weight: 0n, count: 0n });
  h.escrow.isPending.mockReset();
  h.escrow.isPending.mockReturnValue(false);
  h.escrow.error = null;
  h.wallet.publicKey = "GVIEWER";
  h.api.fetchUserJobs.mockReset();
  h.api.fetchUserJobs.mockResolvedValue([]);
  h.api.fetchRatingsReceived.mockReset();
  h.api.fetchRatingsReceived.mockResolvedValue([]);
  h.api.fetchTransactions.mockReset();
  h.api.fetchTransactions.mockResolvedValue({
    data: [],
    pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
  });
  h.api.fetchUserProfile.mockReset();
  h.api.fetchUserProfile.mockResolvedValue(null);
  h.api.updateUserProfile.mockReset();
  h.api.updateUserProfile.mockResolvedValue({});
  h.api.authenticate.mockReset();
  h.api.authenticate.mockResolvedValue("test-jwt-token");
});

afterEach(() => cleanup());

describe("Profile reputation", () => {
  it("shows the weighted average for the address in the route", async () => {
    h.escrow.getReputation.mockResolvedValue({ total_score: 9n, weight: 2n, count: 2n });

    render(<Profile />);

    expect(await summary("Rating: 4.50 / 5 from 2 review(s)")).toBeTruthy();
    expect(h.escrow.getReputation).toHaveBeenCalledWith(ADDRESS);
  });

  it("falls back to the raw count for aggregates written before weighting", async () => {
    // `weight` is 0 for ratings stored before the amount-weighted aggregate
    // existed, so the plain mean is the only thing available.
    h.escrow.getReputation.mockResolvedValue({ total_score: 8n, weight: 0n, count: 2n });

    render(<Profile />);

    expect(await summary("Rating: 4.00 / 5 from 2 review(s)")).toBeTruthy();
  });

  it("says there is nothing to show yet for an unrated address", async () => {
    h.escrow.getReputation.mockResolvedValue({ total_score: 0n, weight: 0n, count: 0n });

    render(<Profile />);

    expect(await screen.findByText("No ratings yet.")).toBeTruthy();
  });

  it("shows a loading state while the read is in flight", async () => {
    h.escrow.getReputation.mockImplementation(() => new Promise(() => {}));

    render(<Profile />);

    expect(screen.getByText("Loading reputation…")).toBeTruthy();
    expect(screen.queryByText("No ratings yet.")).toBeNull();
  });

  it("reports a failed read instead of claiming the address has no ratings", async () => {
    h.escrow.getReputation.mockRejectedValue(
      new ContractReadError("unavailable", "Failed to fetch"),
    );

    render(<Profile />);

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Couldn't reach Stellar/,
    );
    expect(screen.queryByText("No ratings yet.")).toBeNull();
  });

  it("calls an address that cannot exist a bad link, not an empty profile", async () => {
    h.escrow.getReputation.mockRejectedValue(
      new ContractReadError("not-found", "Unsupported address type: nope"),
    );

    render(<Profile />);

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /doesn't look like a Stellar account/,
    );
    expect(screen.queryByText("No ratings yet.")).toBeNull();
  });

  it("reads the aggregate with no wallet connected (issue #108)", async () => {
    // A profile is public: neither the address nor the aggregate waits for a
    // wallet, and the page no longer nags the visitor to connect one.
    h.wallet.publicKey = null;
    h.escrow.getReputation.mockResolvedValue({ total_score: 9n, weight: 2n, count: 2n });

    render(<Profile />);

    expect(await summary("Rating: 4.50 / 5 from 2 review(s)")).toBeTruthy();
    expect(screen.getByText(ADDRESS)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Freighter" })).toBeNull();
    expect(h.wallet.connect).not.toHaveBeenCalled();
  });

  it("does not render notification preferences if the connected wallet is not the profile owner", () => {
    h.wallet.publicKey = "GDIFFERENT";
    render(<Profile />);
    expect(screen.queryByLabelText("Notification Preferences")).toBeNull();
    expect(screen.queryByText("Email Notifications")).toBeNull();
  });

  it("renders notification preferences and saves updated preferences for the profile owner", async () => {
    h.wallet.publicKey = ADDRESS;
    h.api.fetchUserProfile.mockResolvedValue({
      id: "u-1",
      stellarAddress: ADDRESS,
      email: "existing@example.com",
      notifyOnDispute: true,
      notifyOnRelease: false,
      notifyOnRefund: true,
    });
    h.api.updateUserProfile.mockResolvedValue({
      id: "u-1",
      stellarAddress: ADDRESS,
      email: "newemail@example.com",
      notifyOnDispute: true,
      notifyOnRelease: true,
      notifyOnRefund: false,
    });

    render(<Profile />);

    // Waits for the form to populate
    const emailInput = (await screen.findByLabelText("Email Address")) as HTMLInputElement;
    await waitFor(() => {
      expect(emailInput.value).toBe("existing@example.com");
    });

    const disputeCheckbox = screen.getByLabelText(
      "A dispute is opened on one of my jobs",
    ) as HTMLInputElement;
    const releaseCheckbox = screen.getByLabelText("A milestone is released") as HTMLInputElement;
    const refundCheckbox = screen.getByLabelText("An escrow is refunded") as HTMLInputElement;

    expect(disputeCheckbox.checked).toBe(true);
    expect(releaseCheckbox.checked).toBe(false);
    expect(refundCheckbox.checked).toBe(true);

    // Modify form values
    fireEvent.change(emailInput, { target: { value: "newemail@example.com" } });
    fireEvent.click(releaseCheckbox);
    fireEvent.click(refundCheckbox);

    expect(releaseCheckbox.checked).toBe(true);
    expect(refundCheckbox.checked).toBe(false);

    // Submit form
    fireEvent.click(screen.getByRole("button", { name: "Save Preferences" }));

    await waitFor(() => {
      expect(h.api.authenticate).toHaveBeenCalledWith(ADDRESS, h.wallet.signMessage);
      expect(h.api.updateUserProfile).toHaveBeenCalledWith(
        {
          email: "newemail@example.com",
          notifyOnDispute: true,
          notifyOnRelease: true,
          notifyOnRefund: false,
        },
        "test-jwt-token",
      );
    });

    expect(
      await screen.findByText("Notification preferences saved successfully."),
    ).toBeTruthy();
  });
});

describe("Profile job history (#69)", () => {
  it("lists past jobs with the role, the status and a link to the escrow", async () => {
    h.api.fetchUserJobs.mockResolvedValue([
      job(),
      job({
        id: "job-2",
        escrowId: null,
        title: "Draft job",
        status: "CREATED",
        client: { stellarAddress: "GSOMEONE_ELSE" },
        freelancer: { stellarAddress: ADDRESS },
      }),
    ]);

    render(<Profile />);

    // The job where the profile address is the client, and the one where it is
    // the freelancer, both belong to the history.
    expect(await screen.findByText("Landing page redesign")).toBeTruthy();
    expect(screen.getByText("Draft job")).toBeTruthy();
    expect(screen.getByText(/Client · Total: 2\.5 USDC/)).toBeTruthy();
    expect(screen.getByText(/Freelancer · Total: 2\.5 USDC/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open job #7" }).getAttribute("href")).toBe(
      "/jobs/7",
    );
    // A job with no on-chain escrow is listed but not linked.
    expect(screen.getByText("Not funded on-chain yet")).toBeTruthy();
    expect(h.api.fetchUserJobs).toHaveBeenCalledWith(ADDRESS);
  });

  it("shows an empty state when the address has no jobs", async () => {
    render(<Profile />);

    expect(await screen.findByText("No jobs yet.")).toBeTruthy();
  });

  it("reports a failed history load instead of showing an empty list", async () => {
    h.api.fetchUserJobs.mockRejectedValue(new Error("Could not load jobs (HTTP 500)"));
    h.api.fetchRatingsReceived.mockResolvedValue([]);

    render(<Profile />);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not load jobs (HTTP 500)",
    );
    expect(screen.queryByText("No jobs yet.")).toBeNull();
  });
});

describe("Profile rating breakdown (#69)", () => {
  it("shows each rating's score, job and date", async () => {
    h.api.fetchRatingsReceived.mockResolvedValue([
      rating({ score: 5, createdAt: "2026-01-03T00:00:00.000Z", comment: "Great work" }),
      rating({
        id: "rating-2",
        score: 3,
        createdAt: "2026-02-04T00:00:00.000Z",
        job: { id: "job-2", title: "Logo refresh", escrowId: null, status: "COMPLETED" },
      }),
    ]);

    render(<Profile />);

    // Score and job title, so a rating is attributable rather than an anonymous
    // number, plus the date it was given.
    expect(await screen.findByText("5 / 5")).toBeTruthy();
    expect(screen.getByText("3 / 5")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Landing page redesign" }).getAttribute("href")).toBe(
      "/jobs/7",
    );
    // A rating whose job never reached the chain is still shown, unlinked.
    expect(screen.getByText("Logo refresh")).toBeTruthy();
    expect(
      screen.getByText(new Date("2026-01-03T00:00:00.000Z").toLocaleDateString()),
    ).toBeTruthy();
    expect(screen.getByText("“Great work”")).toBeTruthy();
    expect(h.api.fetchRatingsReceived).toHaveBeenCalledWith(ADDRESS);
  });

  it("shows an empty state when the address has not been rated", async () => {
    render(<Profile />);

    expect(await screen.findByText("No ratings received yet.")).toBeTruthy();
  });
});

describe("Profile transaction history (#72)", () => {
  it("lists escrow, action, amount and an explorer link per indexed event", async () => {
    h.api.fetchTransactions.mockImplementation(async (_address, page = 1) => ({
      data: [
        transaction(),
        transaction({
          id: "evt-9",
          escrowId: "7",
          action: "created",
          amount: null,
          txHash: "ffff0000aaaa",
          ledger: 9,
        }),
      ],
      pagination: { page, limit: 20, total: 21, totalPages: 2 },
    }));

    render(<Profile />);

    // The raw event name is not what a client should have to read.
    expect(await screen.findByText("Milestone released")).toBeTruthy();
    expect(screen.getByText("Escrow created")).toBeTruthy();
    // Both rows are on the same escrow and link to it.
    expect(screen.getAllByRole("link", { name: "#7" })[0].getAttribute("href")).toBe("/jobs/7");
    expect(screen.getByText("0.3 USDC")).toBeTruthy();
    // An event that moved nothing shows a dash rather than "0".
    expect(screen.getByText("—")).toBeTruthy();
    const explorer = screen.getByRole("link", { name: "abc123def456…" });
    expect(explorer.getAttribute("href")).toContain("/tx/abc123def4567890");
    expect(h.api.fetchTransactions).toHaveBeenCalledWith(ADDRESS, 1);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect(
      await screen.findByText(
        (_content, element) =>
          element?.textContent?.replace(/\s+/g, " ").trim() === "Page 2 of 2",
      ),
    ).toBeTruthy();
    expect(h.api.fetchTransactions).toHaveBeenLastCalledWith(ADDRESS, 2);
  });

  it("shows an empty state when there is no on-chain activity", async () => {
    render(<Profile />);

    expect(await screen.findByText("No on-chain activity yet.")).toBeTruthy();
  });
});
