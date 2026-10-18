/**
 * users.ts
 *
 * POST /api/users/auth            — issue JWT after verifying a signed Stellar challenge
 * GET  /api/users/:addr           — get public profile
 * GET  /api/users/:addr/transactions — on-chain history for the user's escrows
 * GET  /api/users/:addr/reminders — milestones that are due soon or overdue
 * PUT  /api/users/me              — update display name / bio (auth required)
 *
 * Auth flow (challenge-response):
 *   1. Client calls GET /api/users/challenge?address=G...
 *   2. Server returns a random nonce.
 *   3. Client signs nonce with Freighter (Stellar keypair).
 *   4. Client posts { address, signature, nonce } to /api/users/auth.
 *   5. Server verifies signature with stellar-sdk, issues JWT.
 *
 * Nonces are stored in the database (single-use, 60s TTL) so they survive
 * restarts and work across instances.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { SignJWT } from "jose";
import { prisma } from "../db";
import { config } from "../config";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/errorHandler";
import { consumeNonce, issueNonce, type AuthNonceStore } from "../lib/authNonce";
import { verifySignedMessage } from "../lib/signature";
import { isValidStellarAddress } from "../lib/stellarAddress";
import { formatBaseUnitsForAsset } from "../lib/assets";
import { buildMilestoneReminders, parseHorizonHours } from "../lib/reminders";

export const usersRouter = Router();

const secret = new TextEncoder().encode(config.JWT_SECRET);

// `prisma.authNonce` structurally satisfies the store interface.
const nonceStore = prisma.authNonce as unknown as AuthNonceStore;

// GET /api/users/challenge?address=G...
usersRouter.get("/challenge", async (req, res, next) => {
  try {
    const address = String(req.query.address ?? "");
    if (!isValidStellarAddress(address)) throw new AppError(400, "Invalid Stellar address");

    const nonce = await issueNonce(nonceStore, address);
    res.json({ nonce });
  } catch (err) {
    next(err);
  }
});

// POST /api/users/auth
export const authSchema = z.object({
  address: z.string().refine(isValidStellarAddress, "Invalid Stellar address"),
  /** Base64-encoded signature of the nonce */
  signature: z.string(),
  nonce: z.string(),
});

usersRouter.post("/auth", validate(authSchema), async (req, res, next) => {
  try {
    const { address, signature, nonce } = req.body as z.infer<typeof authSchema>;

    // Single use: consuming deletes the stored nonce on a match.
    const consumed = await consumeNonce(nonceStore, address, nonce);
    if (!consumed) throw new AppError(401, "Invalid or expired nonce");

    // Verify the SEP-53 signature the wallet produced over the nonce.
    if (!verifySignedMessage(address, nonce, signature)) {
      throw new AppError(401, "Signature verification failed");
    }

    // Upsert user
    const user = await prisma.user.upsert({
      where: { stellarAddress: address },
      create: { stellarAddress: address },
      update: {},
    });

    const token = await new SignJWT({ sub: address })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("7d")
      .sign(secret);

    res.json({ token, user });
  } catch (err) {
    next(err);
  }
});

// GET /api/users/freelancers (and GET /api/users) — public freelancer directory (#68)
const getFreelancersHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const sortBy = (
      typeof req.query.sortBy === "string" ? req.query.sortBy : "reputation"
    ).toLowerCase();
    const sortOrder =
      (typeof req.query.sortOrder === "string" ? req.query.sortOrder : "desc").toLowerCase() ===
      "asc"
        ? "asc"
        : "desc";
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));

    const where = search
      ? {
          OR: [
            { stellarAddress: { contains: search, mode: "insensitive" as const } },
            { displayName: { contains: search, mode: "insensitive" as const } },
            { bio: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {};

    const users = await prisma.user.findMany({
      where,
      include: {
        ratingsReceived: {
          select: { score: true },
        },
        jobsAsFreelancer: {
          select: { id: true, status: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const formatted = users.map((user) => {
      const totalRatings = user.ratingsReceived.length;
      const sumScore = user.ratingsReceived.reduce((acc, r) => acc + r.score, 0);
      const averageScore = totalRatings > 0 ? Number((sumScore / totalRatings).toFixed(2)) : 0;
      const completedJobsCount = user.jobsAsFreelancer.filter(
        (j) => j.status === "COMPLETED",
      ).length;
      const totalJobsCount = user.jobsAsFreelancer.length;

      return {
        id: user.id,
        stellarAddress: user.stellarAddress,
        displayName: user.displayName,
        bio: user.bio,
        createdAt: user.createdAt,
        averageScore,
        totalRatings,
        completedJobsCount,
        totalJobsCount,
      };
    });

    formatted.sort((a, b) => {
      if (sortBy === "jobs") {
        if (a.completedJobsCount !== b.completedJobsCount) {
          return sortOrder === "asc"
            ? a.completedJobsCount - b.completedJobsCount
            : b.completedJobsCount - a.completedJobsCount;
        }
        return sortOrder === "asc"
          ? a.totalRatings - b.totalRatings
          : b.totalRatings - a.totalRatings;
      }

      if (sortBy === "recent") {
        const timeA = new Date(a.createdAt).getTime();
        const timeB = new Date(b.createdAt).getTime();
        return sortOrder === "asc" ? timeA - timeB : timeB - timeA;
      }

      // Default: "reputation"
      if (a.averageScore !== b.averageScore) {
        return sortOrder === "asc"
          ? a.averageScore - b.averageScore
          : b.averageScore - a.averageScore;
      }
      if (a.totalRatings !== b.totalRatings) {
        return sortOrder === "asc"
          ? a.totalRatings - b.totalRatings
          : b.totalRatings - a.totalRatings;
      }
      return sortOrder === "asc"
        ? a.completedJobsCount - b.completedJobsCount
        : b.completedJobsCount - a.completedJobsCount;
    });

    const total = formatted.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const offset = (page - 1) * limit;
    const paged = formatted.slice(offset, offset + limit);

    res.json({
      freelancers: paged,
      total,
      page,
      limit,
      totalPages,
    });
  } catch (err) {
    next(err);
  }
};

usersRouter.get("/freelancers", getFreelancersHandler);
usersRouter.get("/", getFreelancersHandler);

// GET /api/users/:address/transactions
//
// The consolidated history a single action-at-a-time UI never had (issue #72).
// A user's history is the indexed events on the escrows of the jobs they took
// part in, newest ledger first. The event's `amount` is returned in whole units
// of the job's asset (like `Job.totalAmountUsdc`) rather than raw base units, and
// `txHash` is what the client turns into an explorer link.
usersRouter.get("/:address/transactions", async (req, res, next) => {
  try {
    const address = req.params.address;
    const jobs = await prisma.job.findMany({
      where: {
        OR: [
          { client: { stellarAddress: address } },
          { freelancer: { stellarAddress: address } },
        ],
      },
      select: { escrowId: true, asset: true },
    });

    const assetByEscrow = new Map<string, string>();
    for (const job of jobs) {
      if (job.escrowId !== null) assetByEscrow.set(job.escrowId.toString(), job.asset);
    }
    const escrowIds = [...assetByEscrow.keys()].map((id) => BigInt(id));
    if (escrowIds.length === 0) {
      res.json([]);
      return;
    }

    const events = await prisma.chainEvent.findMany({
      where: { escrowId: { in: escrowIds } },
      orderBy: { ledger: "desc" },
      take: 200,
    });

    res.json(
      events.map((event) => {
        const symbol = assetByEscrow.get(event.escrowId.toString()) ?? null;
        return {
          id: event.id,
          escrowId: event.escrowId.toString(),
          action: event.action,
          amount: event.amount === null ? null : formatBaseUnitsForAsset(event.amount.toString(), symbol),
          asset: symbol,
          txHash: event.txHash,
          ledger: event.ledger,
          createdAt: event.createdAt,
        };
      }),
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:address/reminders
//
// The in-app half of issue #74: the milestones on the address's open jobs whose
// deadline has passed or is inside the horizon (`?withinHours=`, default from
// `REMINDER_HORIZON_HOURS`). Derived on read rather than stored, so a reminder
// cannot go stale and a released milestone stops reminding immediately.
//
// Email delivery is not implemented — `User` has no email address — so this is
// the only channel; `/api/users/:address/reminders` is where a mailer would
// read from (see lib/reminders.ts).
usersRouter.get("/:address/reminders", async (req, res, next) => {
  try {
    const address = req.params.address;
    const withinHours = parseHorizonHours(
      req.query.withinHours,
      config.REMINDER_HORIZON_HOURS,
    );

    // Terminal states are excluded: a completed, disputed or refunded escrow has
    // no deadline left to act on.
    const jobs = await prisma.job.findMany({
      where: {
        status: { in: ["CREATED", "FUNDED", "ACTIVE"] },
        OR: [
          { client: { stellarAddress: address } },
          { freelancer: { stellarAddress: address } },
        ],
      },
      include: {
        milestones: {
          where: { status: "PENDING", deadline: { not: null } },
          orderBy: { index: "asc" },
        },
        client: { select: { stellarAddress: true } },
        freelancer: { select: { stellarAddress: true } },
      },
    });

    res.json(buildMilestoneReminders(jobs, address, new Date(), withinHours));
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:address
usersRouter.get("/:address", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { stellarAddress: req.params.address },
      include: { _count: { select: { jobsAsFreelancer: true, jobsAsClient: true } } },
    });
    if (!user) throw new AppError(404, "User not found");
    res.json(user);
  } catch (err) {
    next(err);
  }
});

// GET /api/users/me — the authenticated user's own profile (#67)
//
// Registered before `/:address`, otherwise Express would match "me" as an
// address. The public `/:address` route intentionally returns the same row.
usersRouter.get("/me", requireAuth, async (_req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { stellarAddress: res.locals.stellarAddress },
    });
    if (!user) throw new AppError(404, "User not found");
    res.json(user);
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/me
export const updateSchema = z.object({
  displayName: z.string().max(80).optional(),
  bio: z.string().max(500).optional(),
  email: z
    .string()
    .email()
    .or(z.literal(""))
    .optional()
    .nullable()
    .transform((val) => (val === "" ? null : val)),
  notifyOnDispute: z.boolean().optional(),
  notifyOnRelease: z.boolean().optional(),
  notifyOnRefund: z.boolean().optional(),
});

usersRouter.put("/me", requireAuth, validate(updateSchema), async (req, res, next) => {
  try {
    const user = await prisma.user.upsert({
      where: { stellarAddress: res.locals.stellarAddress },
      update: req.body,
      create: {
        stellarAddress: res.locals.stellarAddress,
        ...req.body,
      },
    });
    res.json(user);
  } catch (err) {
    next(err);
  }
});

