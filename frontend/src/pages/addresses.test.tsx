/**
 * Every page that shows an address has to make it copyable (#85): the address is
 * 56 characters and retyping or hand-selecting one is how funds go to the wrong
 * account. The component's own behaviour is covered in AddressField.test.tsx;
 * this file guards the wiring — the pages under test are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  escrow: {
    getEscrow: vi.fn(),
    getReputation: vi.fn(),
    releaseMilestone: vi.fn(),
    openDispute: vi.fn(),
    reclaimDisputed: vi.fn(),
    submitRating: vi.fn(),
    getDisputeDeadline: vi.fn(),
    isPending: vi.fn(() => false),
    hasPendingWrite: vi.fn(() => false),
    error: null,
    lastFailure: null,
  },
  wallet: {
    publicKey: "GCLIENT" as string | null,
    connect: vi.fn(),
    connecting: false,
    error: null,
  },
  fetchJobs: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useParams: () => ({ id: "7", address: "GPROFILE" }),
  useNavigate: () => vi.fn(),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock("../hooks/wallet-context", () => ({ useWallet: () => h.wallet }));
// Fiat estimates (#76) read an external price feed; no rate in these tests.
vi.mock("../lib/prices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/prices")>()),
  getFiatRates: async () => ({}),
}));
vi.mock("../hooks/useEscrow", () => ({ useEscrow: () => h.escrow }));
vi.mock("../lib/api", () => ({
  fetchJobs: h.fetchJobs,
  // Profile now loads the viewed address's history and ratings (#69, #72), and
  // Dashboard loads the connected wallet's milestone reminders (#74).
  fetchUserJobs: vi.fn(async () => []),
  fetchRatingsReceived: vi.fn(async () => []),
  fetchTransactions: vi.fn(async () => []),
  fetchReminders: vi.fn(async () => []),
  authenticate: vi.fn(),
  createJob: vi.fn(),
  linkEscrowId: vi.fn(),
  submitRating: vi.fn(),
  // The job page mounts the conversation and the nav badge reads unread counts.
  fetchMessages: vi.fn(async () => []),
  sendMessage: vi.fn(),
  markMessagesRead: vi.fn(async () => 0),
  fetchUnreadCounts: vi.fn(async () => ({ total: 0, byJob: [] })),
}));

import Dashboard from "./Dashboard";
import JobDetail from "./JobDetail";
import Profile from "./Profile";

const CLIENT = "GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B";
const FREELANCER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const writeText = vi.fn(async () => undefined);

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  h.escrow.getEscrow.mockResolvedValue({
    client: CLIENT,
    freelancer: FREELANCER,
    token: "CTOKEN",
    total_amount: 20_000_000n,
    milestones: [{ amount: 20_000_000n, released: false, released_amount: 0n, deadline: 0n }],
    status: "Active",
    created_at: 0n,
    expiry: 0n,
  });
  h.escrow.getReputation.mockResolvedValue({ total_score: 5n, weight: 1n, count: 1n });
  h.fetchJobs.mockResolvedValue([]);
  h.wallet.publicKey = CLIENT;
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "clipboard");
});

async function copies(label: string, address: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(address));
  writeText.mockClear();
}

describe("addresses are copyable everywhere they are shown", () => {
  it("JobDetail: client and freelancer, each with a QR", async () => {
    render(<JobDetail />);
    await screen.findByText("Milestones");

    expect(screen.getByRole("button", { name: "Show QR code for Client address" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show QR code for Freelancer address" })).toBeTruthy();
    await copies("Copy Client address", CLIENT);
    await copies("Copy Freelancer address", FREELANCER);
  });

  it("Profile: the address being viewed", async () => {
    render(<Profile />);

    await copies("Copy profile address", "GPROFILE");
    fireEvent.click(screen.getByRole("button", { name: "Show QR code for profile address" }));
    expect(screen.getByRole("img", { name: "QR code for profile address" })).toBeTruthy();
  });

  it("Dashboard: the connected wallet and every listed client", async () => {
    h.fetchJobs.mockResolvedValue([
      {
        id: "job-1",
        escrowId: 7,
        title: "t",
        status: "ACTIVE",
        totalAmount: 1,
        client: { stellarAddress: FREELANCER },
      },
    ]);
    render(<Dashboard />);

    await screen.findByText("t");
    await copies("Copy your wallet address", CLIENT);
    await copies("Copy Client address", FREELANCER);
    // The QR is offered for the connected wallet, not for each list row.
    expect(screen.getAllByRole("button", { name: /Show QR code/ })).toHaveLength(1);
  });
});
