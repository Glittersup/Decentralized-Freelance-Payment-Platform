import { describe, expect, it } from "vitest";
import {
  DEFAULT_HORIZON_HOURS,
  MAX_HORIZON_HOURS,
  buildMilestoneReminders,
  classifyMilestoneDeadline,
  parseHorizonHours,
  type ReminderJob,
} from "../lib/reminders";

const CLIENT = "GCLIENT";
const FREELANCER = "GFREELANCER";
const NOW = new Date("2026-01-10T12:00:00.000Z");
const HORIZON_MS = DEFAULT_HORIZON_HOURS * 3_600_000;

/** A deadline `hours` from `NOW` (negative for the past). */
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

function job(overrides: Partial<ReminderJob> = {}): ReminderJob {
  return {
    id: "job-1",
    title: "Landing page redesign",
    escrowId: 7n,
    client: { stellarAddress: CLIENT },
    freelancer: { stellarAddress: FREELANCER },
    milestones: [
      {
        index: 0,
        description: "Design",
        amount: "1.5",
        status: "PENDING",
        deadline: at(12),
      },
    ],
    ...overrides,
  };
}

describe("classifyMilestoneDeadline", () => {
  it("calls a passed deadline overdue", () => {
    expect(classifyMilestoneDeadline(at(-1), NOW, HORIZON_MS)).toBe("overdue");
    // The deadline itself is the last moment work was due, not a grace second.
    expect(classifyMilestoneDeadline(NOW, NOW, HORIZON_MS)).toBe("overdue");
  });

  it("calls a deadline inside the horizon due soon", () => {
    expect(classifyMilestoneDeadline(at(1), NOW, HORIZON_MS)).toBe("due-soon");
    expect(classifyMilestoneDeadline(at(DEFAULT_HORIZON_HOURS), NOW, HORIZON_MS)).toBe(
      "due-soon",
    );
  });

  it("says nothing while the deadline is comfortably away", () => {
    expect(classifyMilestoneDeadline(at(DEFAULT_HORIZON_HOURS + 1), NOW, HORIZON_MS)).toBeNull();
  });
});

describe("buildMilestoneReminders", () => {
  it("reminds the milestone's parties of a deadline inside the horizon", () => {
    const reminders = buildMilestoneReminders([job()], FREELANCER, NOW);

    expect(reminders).toEqual([
      {
        jobId: "job-1",
        title: "Landing page redesign",
        escrowId: "7",
        milestoneIndex: 0,
        description: "Design",
        amount: "1.5",
        deadline: at(12).toISOString(),
        kind: "due-soon",
        role: "freelancer",
      },
    ]);
  });

  it("names the viewer's role, so the reminder can say what they owe", () => {
    expect(buildMilestoneReminders([job()], CLIENT, NOW)[0].role).toBe("client");
  });

  it("does not remind anyone about a released milestone", () => {
    // The money is already out; there is nothing left to act on.
    const released = job({
      milestones: [{ index: 0, description: null, amount: "1", status: "RELEASED", deadline: at(-5) }],
    });

    expect(buildMilestoneReminders([released], CLIENT, NOW)).toEqual([]);
  });

  it("ignores milestones with no deadline", () => {
    const noDeadline = job({
      milestones: [{ index: 0, description: null, amount: "1", status: "PENDING", deadline: null }],
    });

    expect(buildMilestoneReminders([noDeadline], CLIENT, NOW)).toEqual([]);
  });

  it("never reminds an address that is not a party to the job", () => {
    expect(buildMilestoneReminders([job()], "GSTRANGER", NOW)).toEqual([]);
  });

  it("lists overdue reminders first, then the soonest deadline", () => {
    const jobs = [
      job({
        id: "job-a",
        milestones: [
          { index: 1, description: null, amount: "1", status: "PENDING", deadline: at(30) },
          { index: 0, description: null, amount: "1", status: "PENDING", deadline: at(-2) },
        ],
      }),
      job({
        id: "job-b",
        milestones: [{ index: 0, description: null, amount: "1", status: "PENDING", deadline: at(4) }],
      }),
      // Outside the horizon: not a reminder at all.
      job({
        id: "job-c",
        milestones: [{ index: 0, description: null, amount: "1", status: "PENDING", deadline: at(200) }],
      }),
    ];

    const reminders = buildMilestoneReminders(jobs, CLIENT, NOW);

    expect(reminders.map((r) => [r.jobId, r.milestoneIndex, r.kind])).toEqual([
      ["job-a", 0, "overdue"],
      ["job-b", 0, "due-soon"],
      ["job-a", 1, "due-soon"],
    ]);
  });

  it("honours a caller-supplied horizon", () => {
    const jobs = [
      job({
        milestones: [{ index: 0, description: null, amount: "1", status: "PENDING", deadline: at(100) }],
      }),
    ];

    expect(buildMilestoneReminders(jobs, CLIENT, NOW, 24)).toEqual([]);
    expect(buildMilestoneReminders(jobs, CLIENT, NOW, 24 * 7)).toHaveLength(1);
  });

  it("leaves the escrow id null for a job that never reached the chain", () => {
    expect(buildMilestoneReminders([job({ escrowId: null })], CLIENT, NOW)[0].escrowId).toBeNull();
  });
});

describe("parseHorizonHours", () => {
  it("uses the configured default for a missing or unusable value", () => {
    for (const value of [undefined, "", "abc", "0", "-3"]) {
      expect(parseHorizonHours(value, DEFAULT_HORIZON_HOURS)).toBe(DEFAULT_HORIZON_HOURS);
    }
  });

  it("accepts a positive value and clamps an absurd one", () => {
    expect(parseHorizonHours("24", DEFAULT_HORIZON_HOURS)).toBe(24);
    expect(parseHorizonHours(72, DEFAULT_HORIZON_HOURS)).toBe(72);
    // A query string must not be able to sweep years of deadlines.
    expect(parseHorizonHours(10_000_000, DEFAULT_HORIZON_HOURS)).toBe(MAX_HORIZON_HOURS);
  });
});
