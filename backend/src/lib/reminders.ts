/**
 * reminders.ts
 *
 * Milestone due-date reminders (issue #74). A milestone accepts a deadline but
 * nothing ever reminded anyone of it; this module turns a user's open jobs into
 * the reminders their in-app view shows.
 *
 * Kept pure — it takes plain job-shaped objects and a clock rather than reading
 * Prisma or the current time itself — so the classification and ordering are
 * unit-testable without a database (the same approach as `authNonce.ts`).
 *
 * Email: the acceptance criterion is "surfaced in-app, and by email where that is
 * implemented". Email is **not** implemented in this platform — the `User` model
 * stores no email address, so there is nobody to send to — and inventing one
 * would be a larger change than this issue. This module is the single place that
 * would gain a mailer: every reminder it produces names the job, the milestone
 * and the deadline, and is already addressed to a Stellar address.
 */

/** How a deadline reads right now. */
export type ReminderKind = "overdue" | "due-soon";

/** A milestone far enough out to be nobody's problem yet. */
export const DEFAULT_HORIZON_HOURS = 48;

/** Longest horizon the API will honour, so a stray query cannot sweep years. */
export const MAX_HORIZON_HOURS = 24 * 30;

/** A milestone as `buildMilestoneReminders` needs it (Prisma's row satisfies this). */
export interface ReminderMilestone {
  index: number;
  description: string | null;
  amount: unknown;
  status: string;
  deadline: Date | null;
}

/** A job as `buildMilestoneReminders` needs it (Prisma's row satisfies this). */
export interface ReminderJob {
  id: string;
  title: string;
  escrowId: unknown;
  client: { stellarAddress: string } | null;
  freelancer: { stellarAddress: string } | null;
  milestones: ReminderMilestone[];
}

/** One reminder, ready for the in-app list. */
export interface MilestoneReminderView {
  jobId: string;
  title: string;
  /** On-chain escrow id as a string, or `null` while the job is unfunded. */
  escrowId: string | null;
  milestoneIndex: number;
  description: string | null;
  /** The milestone amount, in whole units of the job's asset. */
  amount: string;
  /** The deadline, ISO 8601. */
  deadline: string;
  kind: ReminderKind;
  /** The viewer's part in the job, so the reminder can name it. */
  role: "client" | "freelancer";
}

/**
 * What a deadline means right now: `overdue` once it has passed, `due-soon`
 * inside the horizon, and `null` while it is comfortably away.
 *
 * A deadline exactly `now` counts as overdue: the contract treats the deadline
 * as the last moment work was due, not an extra second of grace.
 */
export function classifyMilestoneDeadline(
  deadline: Date,
  now: Date,
  horizonMs: number,
): ReminderKind | null {
  const remaining = deadline.getTime() - now.getTime();
  if (remaining <= 0) return "overdue";
  if (remaining <= horizonMs) return "due-soon";
  return null;
}

/**
 * The deadline reminders for one address across its open jobs.
 *
 * Only unreleased milestones with a deadline can remind anyone, and only jobs
 * the address is actually a party to — a job someone merely glanced at is not
 * their reminder. Overdue first (they are what needs attention), then soonest.
 */
export function buildMilestoneReminders(
  jobs: ReminderJob[],
  address: string,
  now: Date,
  horizonHours: number = DEFAULT_HORIZON_HOURS,
): MilestoneReminderView[] {
  const horizonMs = horizonHours * 3_600_000;
  const reminders: MilestoneReminderView[] = [];

  for (const job of jobs) {
    const role =
      job.client?.stellarAddress === address
        ? "client"
        : job.freelancer?.stellarAddress === address
          ? "freelancer"
          : null;
    if (!role) continue;

    for (const milestone of job.milestones) {
      if (milestone.status === "RELEASED" || !milestone.deadline) continue;
      const kind = classifyMilestoneDeadline(milestone.deadline, now, horizonMs);
      if (!kind) continue;

      reminders.push({
        jobId: job.id,
        title: job.title,
        escrowId:
          job.escrowId === null || job.escrowId === undefined ? null : String(job.escrowId),
        milestoneIndex: milestone.index,
        description: milestone.description,
        amount: String(milestone.amount),
        deadline: milestone.deadline.toISOString(),
        kind,
        role,
      });
    }
  }

  const rank = (kind: ReminderKind) => (kind === "overdue" ? 0 : 1);
  return reminders.sort(
    (a, b) => rank(a.kind) - rank(b.kind) || a.deadline.localeCompare(b.deadline),
  );
}

/**
 * The horizon from a `?withinHours=` query value, clamped to a sane range, or
 * the configured default when the value is missing or unusable.
 */
export function parseHorizonHours(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_HORIZON_HOURS);
}
