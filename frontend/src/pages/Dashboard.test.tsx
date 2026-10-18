/**
 * Dashboard.test.tsx
 *
 * The landing page is the one route every visitor loads, and it holds the pieces
 * of state most likely to regress silently: the job list (filter + pagination +
 * aborts), the "open a job by id" form, and the connected wallet's milestone
 * reminders (issue #74). The wallet and the API client are mocked — no network,
 * no Freighter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Hoisted so the vi.mock factories below can reference them.
const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  wallet: {
    publicKey: null as string | null,
    connecting: false,
    error: null as string | null,
    connect: vi.fn(async () => "GCLIENT"),
    disconnect: vi.fn(),
    signMessage: vi.fn(async () => "sig"),
  },
  fetchJobs: vi.fn(),
  fetchReminders: vi.fn(async () => [] as unknown[]),
  // Proposal application / applicant review (issue #63).
  fetchProposals: vi.fn(),
  submitProposal: vi.fn(),
  assignFreelancer: vi.fn(),
  // The bookmark list is authenticated and loaded when a wallet connects (#71).
  authenticate: vi.fn(async () => "jwt-1"),
  fetchSavedJobs: vi.fn(async () => [] as unknown[]),
  saveJob: vi.fn(async () => undefined),
  unsaveJob: vi.fn(async () => undefined),
  // Fiat estimates read an external price feed (#76); this is what it returned.
  rates: {} as Record<string, number>,
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => h.navigate,
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("../hooks/wallet-context", () => ({ useWallet: () => h.wallet }));
// Stub the price lookup, keep the real maths: no test may touch the feed.
vi.mock("../lib/prices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/prices")>()),
  getFiatRates: async () => h.rates,
}));
vi.mock("../lib/api", () => ({
  fetchJobs: h.fetchJobs,
  fetchReminders: h.fetchReminders,
  fetchProposals: h.fetchProposals,
  submitProposal: h.submitProposal,
  assignFreelancer: h.assignFreelancer,
  authenticate: h.authenticate,
  fetchSavedJobs: h.fetchSavedJobs,
  saveJob: h.saveJob,
  unsaveJob: h.unsaveJob,
}));

import Dashboard from "./Dashboard";
import type { JobApi, ReminderApi } from "../lib/api";
import { SKILL_TAGS } from "../lib/tags";

const CLIENT = "GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B";

function reminder(overrides: Partial<ReminderApi> = {}): ReminderApi {
  return {
    jobId: "job-1",
    title: "Landing page redesign",
    escrowId: "7",
    milestoneIndex: 1,
    description: "Ship it",
    amount: "2.5",
    deadline: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    kind: "due-soon",
    role: "client",
    ...overrides,
  };
}

function job(overrides: Partial<JobApi> = {}): JobApi {
  return {
    id: "job-1",
    escrowId: 7,
    title: "Landing page redesign",
    status: "ACTIVE",
    asset: "XLM",
    totalAmountUsdc: 1.5,
    client: { stellarAddress: CLIENT },
    ...overrides,
  };
}

/** The query the component last asked the API for. */
function lastQuery(): unknown {
  const calls = h.fetchJobs.mock.calls;
  return calls[calls.length - 1]?.[0];
}

beforeEach(() => {
  h.navigate.mockClear();
  h.fetchJobs.mockReset();
  h.fetchJobs.mockResolvedValue([]);
  h.fetchReminders.mockReset();
  h.fetchReminders.mockResolvedValue([]);
  h.fetchProposals.mockReset();
  h.submitProposal.mockReset();
  h.assignFreelancer.mockReset();
  h.fetchSavedJobs.mockReset();
  h.fetchSavedJobs.mockResolvedValue([]);
  h.saveJob.mockClear();
  h.unsaveJob.mockClear();
  h.wallet.publicKey = null;
  h.wallet.connecting = false;
  h.wallet.error = null;
  h.wallet.connect.mockClear();
  h.rates = {};
});

afterEach(() => cleanup());

describe("Dashboard wallet state", () => {
  it("asks an unconnected visitor to connect", async () => {
    render(<Dashboard />);

    fireEvent.click(screen.getByRole("button", { name: "Connect your Freighter wallet" }));

    await waitFor(() => expect(h.wallet.connect).toHaveBeenCalled());
  });

  it("replaces the prompt with a link to the connected wallet's reputation", () => {
    h.wallet.publicKey = CLIENT;
    render(<Dashboard />);

    expect(screen.queryByRole("button", { name: /Connect your Freighter wallet/ })).toBeNull();
    expect(screen.getByRole("link", { name: "View reputation" }).getAttribute("href")).toBe(
      `/profile/${CLIENT}`,
    );
  });

  it("surfaces a wallet error", () => {
    h.wallet.error = "Freighter wallet not found. Install it from freighter.app";
    render(<Dashboard />);

    expect(screen.getByRole("alert").textContent).toBe(
      "Freighter wallet not found. Install it from freighter.app",
    );
  });
});

describe("Dashboard milestone reminders (#74)", () => {
  it("surfaces the connected wallet's due-soon and overdue milestones", async () => {
    h.wallet.publicKey = CLIENT;
    h.fetchReminders.mockResolvedValue([
      reminder({ kind: "overdue", milestoneIndex: 0 }),
      reminder({ kind: "due-soon", milestoneIndex: 1 }),
    ]);

    render(<Dashboard />);

    expect(await screen.findByText("Overdue")).toBeTruthy();
    expect(screen.getByText("Due soon")).toBeTruthy();
    expect(h.fetchReminders).toHaveBeenCalledWith(CLIENT, expect.any(AbortSignal));
    // The reminder points at the escrow the client has to act on.
    expect(
      screen.getAllByRole("link", { name: "Landing page redesign" })[0].getAttribute("href"),
    ).toBe("/jobs/7");
    expect(screen.getByText(/milestone 1/)).toBeTruthy();
    expect(screen.getByText(/overdue/)).toBeTruthy();
  });

  it("does not ask for reminders when no wallet is connected", async () => {
    render(<Dashboard />);

    await screen.findByText("No jobs found.");
    expect(h.fetchReminders).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Milestone reminders" })).toBeNull();
  });

  it("shows no panel when there is nothing due", async () => {
    h.wallet.publicKey = CLIENT;
    render(<Dashboard />);

    await screen.findByText("No jobs found.");
    expect(screen.queryByRole("heading", { name: "Milestone reminders" })).toBeNull();
  });

  it("keeps the job list intact when the reminder read fails", async () => {
    // Reminders are a convenience: a failure must not blank the page.
    h.wallet.publicKey = CLIENT;
    h.fetchJobs.mockResolvedValue([job()]);
    h.fetchReminders.mockRejectedValue(new Error("Could not load reminders (HTTP 500)"));

    render(<Dashboard />);

    expect(await screen.findByText("Landing page redesign")).toBeTruthy();
    expect(screen.queryByText(/Could not load reminders/)).toBeNull();
  });
});

describe("Dashboard job list", () => {
  it("shows a loading state until the first page arrives", async () => {
    let settle: (jobs: JobApi[]) => void = () => {};
    h.fetchJobs.mockImplementation(
      () =>
        new Promise<JobApi[]>((resolve) => {
          settle = resolve;
        }),
    );

    render(<Dashboard />);

    expect(screen.getByText("Loading jobs…")).toBeTruthy();

    await act(async () => settle([job()]));

    expect(await screen.findByText("Landing page redesign")).toBeTruthy();
    expect(screen.queryByText("Loading jobs…")).toBeNull();
  });

  it("lists each job with its status and, once funded, a link to the escrow", async () => {
    h.fetchJobs.mockResolvedValue([
      job(),
      job({ id: "job-2", escrowId: null, title: "Draft job", status: "CREATED" }),
    ]);

    render(<Dashboard />);

    expect(await screen.findByText("Landing page redesign")).toBeTruthy();
    // Scoped to the badge: the filter dropdown also contains the word ACTIVE.
    expect(screen.getByText("ACTIVE", { selector: "span.badge" }).className).toBe(
      "badge badge-active",
    );
    expect(screen.getByRole("link", { name: "Open job #7" }).getAttribute("href")).toBe("/jobs/7");
    // A job with no on-chain escrow yet is listed but not linked.
    expect(screen.getByText("Not funded on-chain yet")).toBeTruthy();
  });

  it("shows each job's skill tags by their display label", async () => {
    h.fetchJobs.mockResolvedValue([job({ tags: ["web-development", "devops"] })]);

    render(<Dashboard />);

    await screen.findByText("Landing page redesign");
    // Labels, not the stored slugs. Scoped to the row badge: the same label is
    // also an option in the skill filter.
    expect(screen.getByText("Web development", { selector: "span.tag" })).toBeTruthy();
    expect(screen.getByText("DevOps & infrastructure", { selector: "span.tag" })).toBeTruthy();
  });

  it("tolerates a job with no tags at all", async () => {
    h.fetchJobs.mockResolvedValue([job({ tags: undefined })]);

    render(<Dashboard />);

    expect(await screen.findByText("Landing page redesign")).toBeTruthy();
  });

  it("shows an approximate fiat figure beside a job's total (#76)", async () => {
    h.rates = { XLM: 2 };
    h.fetchJobs.mockResolvedValue([job({ totalAmountUsdc: 1.5, asset: "XLM" })]);

    render(<Dashboard />);

    await screen.findByText("Landing page redesign");
    expect(await screen.findByText("$3.00")).toBeTruthy();
  });

  it("leaves the total alone when no rate is available (#76)", async () => {
    h.fetchJobs.mockResolvedValue([job({ totalAmountUsdc: 1.5, asset: "XLM" })]);

    render(<Dashboard />);

    await screen.findByText("Landing page redesign");
    expect(screen.queryByText(/≈/)).toBeNull();
  });

  it("bookmarks a job and reflects it on the button", async () => {
    h.wallet.publicKey = CLIENT;
    h.fetchJobs.mockResolvedValue([job()]);
    render(<Dashboard />);
    await screen.findByText("Landing page redesign");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(h.saveJob).toHaveBeenCalledWith("job-1", "jwt-1"));
    // The same row now offers to unsave it.
    expect(await screen.findByRole("button", { name: "Saved" })).toBeTruthy();
    expect(h.unsaveJob).not.toHaveBeenCalled();
  });

  it("unbookmarks a job that is already saved", async () => {
    h.wallet.publicKey = CLIENT;
    h.fetchJobs.mockResolvedValue([job()]);
    h.fetchSavedJobs.mockResolvedValue([job()]);
    render(<Dashboard />);
    await screen.findByText("Landing page redesign");

    const saved = await screen.findByRole("button", { name: "Saved" });
    fireEvent.click(saved);

    await waitFor(() => expect(h.unsaveJob).toHaveBeenCalledWith("job-1", "jwt-1"));
    expect(await screen.findByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("lists only the saved jobs when Saved only is on", async () => {
    h.wallet.publicKey = CLIENT;
    h.fetchJobs.mockResolvedValue([job()]);
    h.fetchSavedJobs.mockResolvedValue([
      job({ id: "job-9", title: "Bookmarked job", escrowId: 9 }),
    ]);
    render(<Dashboard />);
    await screen.findByText("Landing page redesign");

    fireEvent.click(screen.getByLabelText(/Saved only/));

    // The bookmark list replaces the paginated one rather than merging with it.
    expect(await screen.findByText("Bookmarked job")).toBeTruthy();
    expect(screen.queryByText("Landing page redesign")).toBeNull();
  });

  it("shows an empty state for a wallet with no bookmarks", async () => {
    h.wallet.publicKey = CLIENT;
    h.fetchJobs.mockResolvedValue([job()]);
    render(<Dashboard />);
    await screen.findByText("Landing page redesign");

    fireEvent.click(screen.getByLabelText(/Saved only/));

    expect(await screen.findByText("No saved jobs yet.")).toBeTruthy();
  });

  it("reports a failed bookmark action instead of faking it", async () => {
    h.wallet.publicKey = CLIENT;
    h.fetchJobs.mockResolvedValue([job()]);
    h.saveJob.mockRejectedValue(new Error("Could not save the job (HTTP 500)"));
    render(<Dashboard />);
    await screen.findByText("Landing page redesign");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not save the job (HTTP 500)",
    );
    // The toggle did not half-apply.
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("offers no bookmark control to a visitor with no wallet", async () => {
    h.fetchJobs.mockResolvedValue([job()]);
    render(<Dashboard />);
    await screen.findByText("Landing page redesign");

    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    expect(screen.queryByLabelText(/Saved only/)).toBeNull();
    // Nothing authenticated is fetched until a wallet exists.
    expect(h.fetchSavedJobs).not.toHaveBeenCalled();
  });

  it("shows an empty state rather than a blank list", async () => {
    render(<Dashboard />);

    expect(await screen.findByText("No jobs found.")).toBeTruthy();
  });

  it("reports a failed load instead of pretending the list is empty", async () => {
    h.fetchJobs.mockRejectedValue(new Error("Could not load jobs (HTTP 500)"));

    render(<Dashboard />);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not load jobs (HTTP 500)",
    );
    expect(screen.queryByText("No jobs found.")).toBeNull();
  });

  it("re-fetches from page 1 when the status filter changes", async () => {
    h.fetchJobs.mockResolvedValue([job()]);
    render(<Dashboard />);
    await screen.findByText("Landing page redesign");

    expect(lastQuery()).toEqual({ status: undefined, page: 1, limit: 10 });

    fireEvent.change(screen.getByLabelText(/Filter by status/), {
      target: { value: "COMPLETED" },
    });

    // Back to page 1: page 3 of the previous filter is meaningless under a new one.
    await waitFor(() => expect(lastQuery()).toEqual({ status: "COMPLETED", page: 1, limit: 10 }));
  });

  it("filters by skill tag and re-fetches from page 1", async () => {
    h.fetchJobs.mockResolvedValue([job()]);
    render(<Dashboard />);
    await screen.findByText("Landing page redesign");

    fireEvent.change(screen.getByLabelText(/Filter by skill/), {
      target: { value: "smart-contracts" },
    });

    // The tag is applied by the API, so pagination stays correct.
    await waitFor(() =>
      expect(lastQuery()).toEqual({
        status: undefined,
        tag: "smart-contracts",
        page: 1,
        limit: 10,
      }),
    );
  });

  it("offers every curated skill in the filter", async () => {
    render(<Dashboard />);
    await screen.findByText("No jobs found.");

    const select = screen.getByLabelText(/Filter by skill/) as HTMLSelectElement;
    // "All skills" plus one option per curated tag.
    expect(select.querySelectorAll("option")).toHaveLength(SKILL_TAGS.length + 1);
  });

  it("appends the next page when asked for more", async () => {
    const firstPage = Array.from({ length: 10 }, (_, i) =>
      job({ id: `job-${i}`, escrowId: i, title: `Job ${i}` }),
    );
    h.fetchJobs
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([job({ id: "job-10", escrowId: 10, title: "Job 10" })]);

    render(<Dashboard />);
    await screen.findByText("Job 0");

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Job 10")).toBeTruthy();
    expect(lastQuery()).toEqual({ status: undefined, page: 2, limit: 10 });
    // The already-loaded page stays on screen.
    expect(screen.getByText("Job 0")).toBeTruthy();
    // A short page means there is nothing after it.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
  });

  it("offers no further pages when the first one is short", async () => {
    h.fetchJobs.mockResolvedValue([job()]);

    render(<Dashboard />);
    await screen.findByText("Landing page redesign");

    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("aborts the in-flight request when the page unmounts", async () => {
    h.fetchJobs.mockImplementation(() => new Promise<JobApi[]>(() => {}));

    const { unmount } = render(<Dashboard />);
    const signal = h.fetchJobs.mock.calls[0]?.[1] as AbortSignal;
    expect(signal.aborted).toBe(false);

    unmount();

    // Otherwise the response settles into a component that is gone.
    expect(signal.aborted).toBe(true);
  });

  it("filters jobs by search query and sort option", async () => {
    render(<Dashboard />);
    await screen.findByText("No jobs found.");

    fireEvent.change(screen.getByLabelText(/Search jobs/), {
      target: { value: "redesign" },
    });

    await waitFor(() => {
      expect(lastQuery()).toEqual({
        status: undefined,
        page: 1,
        limit: 10,
        q: "redesign",
      });
    });

    fireEvent.change(screen.getByLabelText(/Sort by/), {
      target: { value: "amount_desc" },
    });

    await waitFor(() => {
      expect(lastQuery()).toEqual({
        status: undefined,
        page: 1,
        limit: 10,
        q: "redesign",
        sort: "amount_desc",
      });
    });
  });

  it("does not report a superseded request as an error", async () => {
    h.fetchJobs.mockRejectedValue(
      new DOMException("The operation was aborted.", "AbortError"),
    );

    render(<Dashboard />);

    await waitFor(() => expect(h.fetchJobs).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Dashboard open-by-id form", () => {
  it("navigates to the job with the typed id, trimmed", async () => {
    render(<Dashboard />);

    fireEvent.change(screen.getByLabelText(/Open a job by on-chain id/), {
      target: { value: " 12 " },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Open" }).closest("form") as HTMLFormElement);

    expect(h.navigate).toHaveBeenCalledWith("/jobs/12");
  });

  it("stays put for a blank id", () => {
    render(<Dashboard />);

    fireEvent.submit(screen.getByRole("button", { name: "Open" }).closest("form") as HTMLFormElement);

    expect(h.navigate).not.toHaveBeenCalled();
    // No validation beyond "not blank" — see #106 for the non-numeric input that
    // this form hands straight to JobDetail.
  });
});

describe("Dashboard proposals and applicants (Issue #63)", () => {
  const FREELANCER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

  beforeEach(() => {
    h.fetchProposals.mockReset();
    h.submitProposal.mockReset();
    h.assignFreelancer.mockReset();
  });

  it("shows Apply button on open jobs when connected as freelancer", async () => {
    h.wallet.publicKey = FREELANCER;
    h.fetchJobs.mockResolvedValue([
      job({ id: "job-open-1", title: "Open Contract", status: "CREATED", client: { stellarAddress: CLIENT } }),
    ]);

    render(<Dashboard />);

    expect(await screen.findByText("Open Contract")).toBeTruthy();
    const applyBtn = screen.getByRole("button", { name: "Apply" });
    expect(applyBtn).toBeTruthy();

    fireEvent.click(applyBtn);
    expect(screen.getByText("Apply for Open Contract")).toBeTruthy();
    expect(screen.getByLabelText(/Cover Letter/)).toBeTruthy();
  });

  it("submits a proposal on open job", async () => {
    h.wallet.publicKey = FREELANCER;
    h.fetchJobs.mockResolvedValue([
      job({ id: "job-open-1", title: "Open Contract", status: "CREATED", client: { stellarAddress: CLIENT } }),
    ]);
    h.submitProposal.mockResolvedValue({ id: "prop-1", status: "PENDING" });

    render(<Dashboard />);
    await screen.findByText("Open Contract");

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    fireEvent.change(screen.getByLabelText(/Cover Letter/), {
      target: { value: "I have 5 years of experience" },
    });
    fireEvent.change(screen.getByLabelText(/Proposed Rate/), {
      target: { value: "100" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Submit Application" }));

    await waitFor(() => {
      expect(h.authenticate).toHaveBeenCalledWith(FREELANCER, expect.any(Function));
      expect(h.submitProposal).toHaveBeenCalledWith(
        "job-open-1",
        { coverLetter: "I have 5 years of experience", proposedRate: "100" },
        "jwt-1",
      );
    });
    expect(await screen.findByText("Application submitted successfully!")).toBeTruthy();
  });

  it("shows View Applicants for client on open job and allows assigning", async () => {
    h.wallet.publicKey = CLIENT;
    h.fetchJobs.mockResolvedValue([
      job({ id: "job-open-1", title: "Open Contract", status: "CREATED", client: { stellarAddress: CLIENT } }),
    ]);
    h.fetchProposals.mockResolvedValue([
      {
        id: "prop-1",
        jobId: "job-open-1",
        freelancerId: "free-1",
        coverLetter: "Pick me please",
        proposedRate: "50",
        status: "PENDING",
        freelancer: { stellarAddress: FREELANCER },
      },
    ]);
    h.assignFreelancer.mockResolvedValue({ id: "job-open-1", status: "CREATED", freelancerId: "free-1" });

    render(<Dashboard />);
    await screen.findByText("Open Contract");

    const viewApplicantsBtn = screen.getByRole("button", { name: "View Applicants" });
    expect(viewApplicantsBtn).toBeTruthy();

    fireEvent.click(viewApplicantsBtn);
    await waitFor(() => expect(h.fetchProposals).toHaveBeenCalledWith("job-open-1"));

    expect(await screen.findByText("Pick me please")).toBeTruthy();
    const assignBtn = screen.getByRole("button", { name: "Assign" });
    expect(assignBtn).toBeTruthy();

    fireEvent.click(assignBtn);
    await waitFor(() => {
      expect(h.assignFreelancer).toHaveBeenCalledWith("job-open-1", FREELANCER, "jwt-1");
    });
  });
});

