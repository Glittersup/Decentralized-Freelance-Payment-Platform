/**
 * Activity.test.tsx
 *
 * The activity page is a read-only view, so the risks are: asking for the
 * wrong address, asking once per role, showing a total that the API call did
 * not justify, and rendering before the reads resolve. The wallet and the API
 * client are mocked — no network, no Freighter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  wallet: {
    publicKey: null as string | null,
    connecting: false,
    error: null as string | null,
    connect: vi.fn(async () => "GCLIENT"),
    disconnect: vi.fn(),
  },
  fetchJobs: vi.fn(),
  // Fiat estimates read an external price feed (#76); this is what it returned.
  rates: {} as Record<string, number>,
}));

vi.mock("../hooks/wallet-context", () => ({ useWallet: () => h.wallet }));
// Stub the price lookup, keep the real maths: no test may touch the feed.
vi.mock("../lib/prices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/prices")>()),
  getFiatRates: async () => h.rates,
}));
vi.mock("../lib/api", () => ({ fetchJobs: h.fetchJobs }));

import Activity from "./Activity";
import type { JobApi, JobListQuery } from "../lib/api";

const WALLET = "GCLIENT00000000000000000000000000000000000000000000000000";

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

/** Answer each `/api/jobs` call from the role it filtered on. */
function respondByRole({ asClient = [], asFreelancer = [] }: { asClient?: JobApi[]; asFreelancer?: JobApi[] }) {
  h.fetchJobs.mockImplementation(async (query: JobListQuery = {}) =>
    query.client ? asClient : asFreelancer,
  );
}

beforeEach(() => {
  h.fetchJobs.mockReset();
  h.fetchJobs.mockResolvedValue([]);
  h.wallet.publicKey = null;
  h.wallet.connecting = false;
  h.wallet.error = null;
  h.wallet.connect.mockClear();
  h.rates = {};
});

afterEach(() => cleanup());

describe("Activity without a wallet", () => {
  it("asks the visitor to connect instead of reading the API", () => {
    render(<Activity />);

    expect(screen.getByRole("button", { name: "Connect your Freighter wallet" })).toBeTruthy();
    expect(h.fetchJobs).not.toHaveBeenCalled();
  });

  it("connects on request", async () => {
    render(<Activity />);

    fireEvent.click(screen.getByRole("button", { name: "Connect your Freighter wallet" }));

    await waitFor(() => expect(h.wallet.connect).toHaveBeenCalled());
  });

  it("shows a wallet error", () => {
    h.wallet.error = "Freighter wallet not found. Install it from freighter.app";
    render(<Activity />);

    expect(screen.getByRole("alert").textContent).toBe(
      "Freighter wallet not found. Install it from freighter.app",
    );
  });
});

describe("Activity reads", () => {
  it("asks for the connected address once per role", async () => {
    h.wallet.publicKey = WALLET;
    render(<Activity />);

    await waitFor(() => expect(h.fetchJobs).toHaveBeenCalledTimes(2));
    expect(h.fetchJobs.mock.calls.map(([query]) => query)).toEqual([
      { client: WALLET, limit: 100 },
      { freelancer: WALLET, limit: 100 },
    ]);
  });

  it("shows a loading state before the reads resolve", async () => {
    h.wallet.publicKey = WALLET;
    h.fetchJobs.mockImplementation(() => new Promise(() => {}));
    render(<Activity />);

    expect(screen.getByText("Loading activity…")).toBeTruthy();
  });

  it("surfaces a failed read", async () => {
    h.wallet.publicKey = WALLET;
    h.fetchJobs.mockRejectedValue(new Error("Could not load jobs (HTTP 500)"));
    render(<Activity />);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Could not load jobs (HTTP 500)"),
    );
  });

  it("does not read the API after the wallet disconnects", async () => {
    h.wallet.publicKey = WALLET;
    const { rerender } = render(<Activity />);
    await waitFor(() => expect(h.fetchJobs).toHaveBeenCalledTimes(2));

    h.wallet.publicKey = null;
    rerender(<Activity />);

    expect(h.fetchJobs).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Connect your Freighter wallet" })).toBeTruthy();
  });
});

describe("Activity summary", () => {
  it("counts open escrows, completed jobs and total jobs", async () => {
    h.wallet.publicKey = WALLET;
    respondByRole({
      asClient: [
        job({ id: "funded", status: "FUNDED" }),
        job({ id: "done", status: "COMPLETED" }),
      ],
      asFreelancer: [job({ id: "active", status: "ACTIVE" }), job({ id: "gone", status: "REFUNDED" })],
    });
    render(<Activity />);

    await waitFor(() => expect(screen.getByText("Active escrows")).toBeTruthy());
    const stat = (label: string) =>
      screen.getByText(label).previousElementSibling?.textContent;

    expect(stat("Active escrows")).toBe("2");
    expect(stat("Completed jobs")).toBe("1");
    expect(stat("Total jobs")).toBe("4");
  });

  it("adds a fiat estimate to a released total (#76)", async () => {
    h.rates = { XLM: 2 };
    h.wallet.publicKey = WALLET;
    respondByRole({
      asFreelancer: [job({ milestones: [{ amount: "1.5", status: "RELEASED" }] })],
    });
    render(<Activity />);

    await waitFor(() => expect(screen.getByText("1.5 XLM", { exact: false })).toBeTruthy());
    expect(screen.getByText("$3.00")).toBeTruthy();
  });

  it("renders the released and still-locked totals per asset", async () => {
    h.wallet.publicKey = WALLET;
    respondByRole({
      asClient: [job({ id: "c", status: "FUNDED" })],
      asFreelancer: [
        job({
          id: "f",
          status: "ACTIVE",
          milestones: [
            { amount: "1.5", status: "RELEASED" },
            { amount: "0.25", status: "PENDING" },
          ],
        }),
      ],
    });
    render(<Activity />);

    await waitFor(() => expect(screen.getByText(/Released:/)).toBeTruthy());
    expect(screen.getByText("1.5 XLM")).toBeTruthy();
    expect(screen.getByText("0.25 XLM")).toBeTruthy();
  });

  it("says none rather than 0 when nothing has been released", async () => {
    h.wallet.publicKey = WALLET;
    respondByRole({ asClient: [job({ status: "FUNDED" })] });
    render(<Activity />);

    // The label is its own <strong>; the value sits beside it in the row.
    await waitFor(() => expect(screen.getByText("Released:")).toBeTruthy());
    expect(screen.getByText("Released:").parentElement?.textContent).toContain("none");
  });

  it("reports the role split", async () => {
    h.wallet.publicKey = WALLET;
    respondByRole({
      asClient: [job({ id: "c1" }), job({ id: "c2" })],
      asFreelancer: [job({ id: "f1" })],
    });
    render(<Activity />);

    await waitFor(() => expect(screen.getByText(/as client/)).toBeTruthy());
    expect(screen.getByText(/as client/).textContent).toContain("2 as client · 1 as freelancer");
  });

  it("says so when the address has no jobs", async () => {
    h.wallet.publicKey = WALLET;
    render(<Activity />);

    await waitFor(() =>
      expect(screen.getByText("No jobs found for this address yet.")).toBeTruthy(),
    );
  });
});
