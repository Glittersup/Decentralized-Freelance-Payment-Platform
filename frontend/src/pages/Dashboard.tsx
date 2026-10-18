/**
 * Dashboard.tsx
 *
 * Landing page: connect the wallet, browse the job list, and open a job by
 * its on-chain id. The list comes from `GET /api/jobs`.
 *
 * The list can be narrowed by status and by skill tag (issue #70); the tag is
 * sent as `?tag=<slug>` and both filters are applied by the API, so pagination
 * stays correct instead of filtering a page client-side.
 *
 * A connected wallet can also bookmark a job (issue #71). "Saved only" swaps
 * the rendered list for the bookmark list, which is already complete, so the
 * pagination control is hidden while it is on.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Layout from "../components/Layout";
import StatusBadge from "../components/StatusBadge";
import AddressField from "../components/AddressField";
import FiatEstimate from "../components/FiatEstimate";
import JobListSkeleton from "../components/JobListSkeleton";
import {
  assignFreelancer,
  authenticate,
  fetchJobs,
  fetchProposals,
  fetchReminders,
  submitProposal,
  type JobApi,
  type ProposalApi,
  type ReminderApi,
} from "../lib/api";
import { SKILL_TAGS, tagLabel } from "../lib/tags";
import { useSavedJobs } from "../hooks/useSavedJobs";
import { useWallet } from "../hooks/wallet-context";
import { parseEscrowId } from "../lib/escrowId";
import { formatDate, formatRemaining } from "../lib/time";

const PAGE_SIZE = 10;
const STATUSES = ["CREATED", "FUNDED", "ACTIVE", "COMPLETED", "DISPUTED", "REFUNDED"];

export default function Dashboard() {
  const { publicKey, connecting, connect, signMessage, error: walletError } = useWallet();
  const [jobId, setJobId] = useState("");
  const [jobIdError, setJobIdError] = useState<string | null>(null);
  const navigate = useNavigate();

  const [status, setStatus] = useState("");
  const [tag, setTag] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [sort, setSort] = useState("");
  const [savedOnly, setSavedOnly] = useState(false);
  const { savedJobs, isSaved, toggle, pendingId, error: savedError } = useSavedJobs();
  const [jobs, setJobs] = useState<JobApi[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [reminders, setReminders] = useState<ReminderApi[]>([]);

  // Proposal application state (issue #63).
  const [applyingJobId, setApplyingJobId] = useState<string | null>(null);
  const [coverLetter, setCoverLetter] = useState("");
  const [proposedRate, setProposedRate] = useState("");
  const [proposalSubmitting, setProposalSubmitting] = useState(false);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [proposalSuccess, setProposalSuccess] = useState<string | null>(null);

  // Client applicant-review state (issue #63).
  const [viewingApplicantsJobId, setViewingApplicantsJobId] = useState<string | null>(null);
  const [applicants, setApplicants] = useState<Record<string, ProposalApi[]>>({});
  const [loadingApplicants, setLoadingApplicants] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  // What actually renders: the bookmark list when "Saved only" is on (it is
  // returned complete), otherwise the paginated API list.
  const visibleJobs = savedOnly ? savedJobs : jobs;

  const load = useCallback(
    async (pageToLoad: number, append: boolean, signal?: AbortSignal) => {
      setJobsLoading(true);
      setJobsError(null);
      try {
        const data = await fetchJobs(
          {
            status: status || undefined,
            tag: tag || undefined,
            ...(searchQuery.trim() ? { q: searchQuery.trim() } : {}),
            ...(sort ? { sort } : {}),
            page: pageToLoad,
            limit: PAGE_SIZE,
          },
          signal,
        );
        setJobs((prev) => (append ? [...prev, ...data] : data));
        setHasMore(data.length === PAGE_SIZE);
        setPage(pageToLoad);
      } catch (e) {
        // Ignore aborts from a superseded request (e.g. fast filter changes).
        if (e instanceof DOMException && e.name === "AbortError") return;
        setJobsError(e instanceof Error ? e.message : String(e));
      } finally {
        setJobsLoading(false);
      }
    },
    [status, tag, searchQuery, sort],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(1, false, controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!publicKey) {
      setReminders([]);
      return;
    }
    const controller = new AbortController();
    // A failed reminder read must not replace the job list's error state with
    // its own; reminders are a convenience, and the list already reports.
    void fetchReminders(publicKey, controller.signal)
      .then(setReminders)
      .catch(() => {
        if (!controller.signal.aborted) setReminders([]);
      });
    return () => controller.abort();
  }, [publicKey]);

  async function handleToggleApplicants(targetJobId: string) {
    if (viewingApplicantsJobId === targetJobId) {
      setViewingApplicantsJobId(null);
      return;
    }
    setViewingApplicantsJobId(targetJobId);
    setActionMessage(null);
    if (!applicants[targetJobId]) {
      setLoadingApplicants(true);
      try {
        const list = await fetchProposals(targetJobId);
        setApplicants((prev) => ({ ...prev, [targetJobId]: list }));
      } catch (err) {
        setActionMessage(err instanceof Error ? err.message : "Failed to load proposals");
      } finally {
        setLoadingApplicants(false);
      }
    }
  }

  async function handleApply(e: React.FormEvent, targetJobId: string) {
    e.preventDefault();
    if (!publicKey) {
      await connect();
      return;
    }
    setProposalSubmitting(true);
    setProposalError(null);
    setProposalSuccess(null);
    try {
      const token = await authenticate(publicKey, signMessage);
      await submitProposal(
        targetJobId,
        {
          coverLetter: coverLetter.trim() || undefined,
          proposedRate: proposedRate.trim() ? proposedRate.trim() : undefined,
        },
        token,
      );
      setProposalSuccess("Application submitted successfully!");
      setCoverLetter("");
      setProposedRate("");
      setTimeout(() => {
        setApplyingJobId(null);
        setProposalSuccess(null);
      }, 2000);
    } catch (err) {
      setProposalError(err instanceof Error ? err.message : "Failed to submit proposal");
    } finally {
      setProposalSubmitting(false);
    }
  }

  async function handleAssign(targetJobId: string, freelancerAddress: string) {
    if (!publicKey) return;
    setAssigning(true);
    setActionMessage(null);
    try {
      const token = await authenticate(publicKey, signMessage);
      await assignFreelancer(targetJobId, freelancerAddress, token);
      setActionMessage("Freelancer assigned successfully!");
      const updatedList = await fetchProposals(targetJobId);
      setApplicants((prev) => ({ ...prev, [targetJobId]: updatedList }));
      void load(1, false);
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "Failed to assign freelancer");
    } finally {
      setAssigning(false);
    }
  }

  return (
    <Layout>
      <h1>My Jobs</h1>

      {!publicKey ? (
        <p>
          <button onClick={() => void connect()} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect your Freighter wallet"}
          </button>{" "}
          to post or manage jobs.
        </p>
      ) : (
        <p>
          Connected as{" "}
          <AddressField address={publicKey} label="your wallet address" truncate qr />.{" "}
          <Link to={`/profile/${publicKey}`}>View reputation</Link>
        </p>
      )}

      {walletError && (
        <p role="alert" aria-live="assertive" className="alert alert-error">
          {walletError}
        </p>
      )}

      {publicKey && reminders.length > 0 && (
        <section className="reminders">
          <h2>Milestone reminders</h2>
          <ul>
            {reminders.map((reminder) => (
              <li key={`${reminder.jobId}:${reminder.milestoneIndex}`}>
                <span
                  className={
                    reminder.kind === "overdue"
                      ? "badge badge-overdue"
                      : "badge badge-due-soon"
                  }
                >
                  {reminder.kind === "overdue" ? "Overdue" : "Due soon"}
                </span>{" "}
                {reminder.escrowId ? (
                  <Link to={`/jobs/${reminder.escrowId}`}>{reminder.title}</Link>
                ) : (
                  <strong>{reminder.title}</strong>
                )}{" "}
                — milestone {reminder.milestoneIndex + 1}
                {reminder.description ? ` (${reminder.description})` : ""} due{" "}
                <time dateTime={reminder.deadline}>{formatDate(reminder.deadline)}</time>
                {reminder.kind === "overdue"
                  ? " — overdue"
                  : ` — in ${formatRemaining(
                      Math.max(
                        0,
                        Math.floor(
                          (new Date(reminder.deadline).getTime() - Date.now()) / 1000,
                        ),
                      ),
                    )}`}
              </li>
            ))}
          </ul>
        </section>
      )}

      <form
        className="open-job-form"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = jobId.trim();
          if (!trimmed) return;
          const parsed = parseEscrowId(trimmed);
          if (parsed === null) {
            setJobIdError(`"${trimmed}" is not a valid escrow id. Enter a non-negative integer.`);
            return;
          }
          setJobIdError(null);
          navigate(`/jobs/${trimmed}`);
        }}
      >
        <label htmlFor="open-job-input">
          Open a job by on-chain id{" "}
          <input
            id="open-job-input"
            value={jobId}
            onChange={(e) => {
              setJobId(e.target.value);
              setJobIdError(null);
            }}
            placeholder="0"
          />
        </label>{" "}
        <button type="submit">Open</button>
        {jobIdError && (
          <p role="alert" className="alert alert-error">
            {jobIdError}
          </p>
        )}
      </form>

      <h2>All jobs</h2>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "center", margin: "1rem 0" }}>
        <label>
          Search jobs{" "}
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search keyword…"
          />
        </label>

        <label htmlFor="filter-status-select">
          Filter by status{" "}
          <select
            id="filter-status-select"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label>
          Filter by skill{" "}
          <select value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">All skills</option>
            {SKILL_TAGS.map((skill) => (
              <option key={skill.slug} value={skill.slug}>
                {skill.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Sort by{" "}
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="">Newest first (default)</option>
            <option value="oldest">Oldest first</option>
            <option value="amount_desc">Highest amount</option>
            <option value="amount_asc">Lowest amount</option>
          </select>
        </label>

        {publicKey && (
          <label>
            <input
              type="checkbox"
              checked={savedOnly}
              onChange={(e) => setSavedOnly(e.target.checked)}
            />{" "}
            Saved only ({savedJobs.length})
          </label>
        )}
      </div>

      {(jobsError || savedError) && (
        <div className="error-state">
          <p role="alert" className="alert alert-error">
            {jobsError ?? savedError}
          </p>
          <button
            type="button"
            className="btn-retry"
            onClick={() => void load(page, false)}
          >
            Retry
          </button>
        </div>
      )}

      {jobsLoading && visibleJobs.length === 0 && <JobListSkeleton />}

      {!jobsLoading && !jobsError && visibleJobs.length === 0 && (
        savedOnly ? (
          <p className="muted" role="status" aria-live="polite">
            No saved jobs yet.
          </p>
        ) : (
          <div className="empty-state card" role="status" aria-live="polite">
            <div className="empty-state-icon" aria-hidden="true">
              📋
            </div>
            <h3>No jobs found.</h3>
            <p className="muted">
              {status
                ? `No jobs match the "${status}" status filter.`
                : "No jobs have been posted yet. Create a new job to get started."}
            </p>
            {status ? (
              <button type="button" onClick={() => setStatus("")}>
                Clear filter
              </button>
            ) : (
              <Link to="/post" className="btn-primary">
                Post a job →
              </Link>
            )}
          </div>
        )
      )}

      {visibleJobs.length > 0 && (
        <ul className="job-list">
          {visibleJobs.map((job) => {
            const isClient = !!publicKey && job.client?.stellarAddress === publicKey;
            const isOpen = job.status === "CREATED" && !job.freelancer;

            return (
              <li key={job.id} style={{ marginBottom: "1rem" }}>
                <strong>{job.title}</strong> <StatusBadge status={job.status} />
                {job.tags && job.tags.length > 0 && (
                  <>
                    {" "}
                    {job.tags.map((slug) => (
                      <span key={slug} className="tag">
                        {tagLabel(slug)}
                      </span>
                    ))}
                  </>
                )}
                <br />
                <span className="muted">
                  Client:{" "}
                  {job.client?.stellarAddress ? (
                    <AddressField
                      address={job.client.stellarAddress}
                      label="Client address"
                      truncate
                    />
                  ) : (
                    "—"
                  )}{" "}
                  · Total: {String(job.totalAmountUsdc)} {job.asset ?? ""}{" "}
                  <FiatEstimate amount={String(job.totalAmountUsdc)} asset={job.asset ?? ""} />
                </span>
                <br />
                {job.escrowId !== null && job.escrowId !== undefined ? (
                  <Link to={`/jobs/${job.escrowId}`}>Open job #{String(job.escrowId)}</Link>
                ) : (
                  <span className="muted">Not funded on-chain yet</span>
                )}
                {publicKey && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className={isSaved(job.id) ? "btn-saved" : "btn-save"}
                      aria-pressed={isSaved(job.id)}
                      disabled={pendingId === job.id}
                      onClick={() => void toggle(job)}
                    >
                      {isSaved(job.id) ? "Saved" : "Save"}
                    </button>
                  </>
                )}

                {/* A freelancer may apply while the job is open and unassigned (#63). */}
                {isOpen && !isClient && (
                  <div style={{ marginTop: "0.5rem" }}>
                    <button
                      className="btn-primary"
                      onClick={() => {
                        setApplyingJobId(applyingJobId === job.id ? null : job.id);
                        setProposalError(null);
                        setProposalSuccess(null);
                      }}
                    >
                      {applyingJobId === job.id ? "Cancel Application" : "Apply"}
                    </button>

                    {applyingJobId === job.id && (
                      <form
                        onSubmit={(e) => void handleApply(e, job.id)}
                        style={{
                          marginTop: "0.5rem",
                          padding: "0.75rem",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--radius)",
                        }}
                      >
                        <h4>Apply for {job.title}</h4>
                        <p>
                          <label>
                            Cover Letter
                            <br />
                            <textarea
                              value={coverLetter}
                              onChange={(e) => setCoverLetter(e.target.value)}
                              placeholder="Describe your qualifications and experience…"
                              minLength={5}
                              rows={3}
                              style={{ width: "100%" }}
                              required
                            />
                          </label>
                        </p>
                        <p>
                          <label>
                            Proposed Rate ({job.asset ?? "USDC"}) (optional)
                            <br />
                            <input
                              type="number"
                              min="0"
                              step="any"
                              value={proposedRate}
                              onChange={(e) => setProposedRate(e.target.value)}
                              placeholder={String(job.totalAmountUsdc)}
                            />
                          </label>
                        </p>
                        {proposalError && (
                          <p
                            role="alert"
                            className="alert alert-error"
                            style={{ marginBottom: "0.5rem" }}
                          >
                            {proposalError}
                          </p>
                        )}
                        {proposalSuccess && (
                          <p className="alert" style={{ marginBottom: "0.5rem" }}>
                            {proposalSuccess}
                          </p>
                        )}
                        <button
                          type="submit"
                          disabled={proposalSubmitting}
                          className="btn-primary"
                        >
                          {proposalSubmitting ? "Submitting…" : "Submit Application"}
                        </button>
                      </form>
                    )}
                  </div>
                )}

                {/* The client reviews applicants and assigns one (#63). */}
                {isOpen && isClient && (
                  <div style={{ marginTop: "0.5rem" }}>
                    <button onClick={() => void handleToggleApplicants(job.id)}>
                      {viewingApplicantsJobId === job.id ? "Hide Applicants" : "View Applicants"}
                    </button>

                    {viewingApplicantsJobId === job.id && (
                      <div
                        style={{
                          marginTop: "0.5rem",
                          padding: "0.75rem",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--radius)",
                        }}
                      >
                        <h4>Applicants</h4>
                        {actionMessage && <p className="alert">{actionMessage}</p>}
                        {loadingApplicants && <p>Loading applicants…</p>}
                        {!loadingApplicants &&
                          (!applicants[job.id] || applicants[job.id].length === 0) && (
                            <p className="muted">No proposals submitted yet.</p>
                          )}
                        {!loadingApplicants &&
                          applicants[job.id]?.map((p) => (
                            <div
                              key={p.id}
                              style={{
                                borderBottom: "1px solid var(--border)",
                                padding: "0.5rem 0",
                              }}
                            >
                              <p>
                                <strong>Freelancer:</strong>{" "}
                                {p.freelancer?.stellarAddress ? (
                                  <AddressField
                                    address={p.freelancer.stellarAddress}
                                    label="Freelancer address"
                                    truncate
                                  />
                                ) : (
                                  "—"
                                )}
                              </p>
                              {p.proposedRate && (
                                <p>
                                  <strong>Proposed Rate:</strong> {String(p.proposedRate)}{" "}
                                  {job.asset ?? "USDC"}
                                </p>
                              )}
                              {p.coverLetter && (
                                <p>
                                  <strong>Cover Letter:</strong> {p.coverLetter}
                                </p>
                              )}
                              <p>
                                <strong>Status:</strong>{" "}
                                <span className={`badge badge-${p.status.toLowerCase()}`}>
                                  {p.status}
                                </span>
                              </p>
                              {p.status === "PENDING" && p.freelancer?.stellarAddress && (
                                <button
                                  className="btn-primary"
                                  disabled={assigning}
                                  onClick={() =>
                                    void handleAssign(job.id, p.freelancer!.stellarAddress)
                                  }
                                >
                                  {assigning ? "Assigning…" : "Assign"}
                                </button>
                              )}
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {hasMore && !savedOnly && (
        <button
          disabled={jobsLoading}
          onClick={() => void load(page + 1, true)}
        >
          {jobsLoading ? "Loading…" : "Load more"}
        </button>
      )}

      <p>
        <Link to="/post">Post a new job →</Link> ·{" "}
        <Link to="/freelancers">Browse freelancers directory →</Link>
      </p>
    </Layout>
  );
}
