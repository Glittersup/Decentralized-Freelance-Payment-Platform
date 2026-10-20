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
import { Prisma } from "@prisma/client";
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

    const direction = Prisma.raw(sortOrder);
    const orderBy =
      sortBy === "jobs"
        ? Prisma.sql`"completedJobsCount" ${direction}, "totalRatings" ${direction}`
        : sortBy === "recent"
          ? Prisma.sql`"createdAt" ${direction}`
          : Prisma.sql`"averageScore" ${direction}, "totalRatings" ${direction}, "completedJobsCount" ${direction}`;
    const searchFilter = search
      ? Prisma.sql`WHERE u."stellarAddress" ILIKE ${`%${search}%`}
          OR u."displayName" ILIKE ${`%${search}%`}
          OR u."bio" ILIKE ${`%${search}%`}`
      : Prisma.empty;
    const offset = (page - 1) * limit;
    const [total, paged] = await Promise.all([
      prisma.user.count({ where }),
      prisma.$queryRaw<
        Array<{
          id: string;
          stellarAddress: string;
          displayName: string | null;
          bio: string | null;
          createdAt: Date;
          averageScore: number;
          totalRatings: number;
          completedJobsCount: number;
          totalJobsCount: number;
        }>
      >(Prisma.sql`
        WITH metrics AS (
          SELECT
            u."id",
            u."stellarAddress",
            u."displayName",
            u."bio",
            u."createdAt",
            COALESCE((
              SELECT AVG(r."score")::float
              FROM "Rating" r
              WHERE r."rateeId" = u."id"
            ), 0::float) AS "averageScore",
            (
              SELECT COUNT(*)::int
              FROM "Rating" r
              WHERE r."rateeId" = u."id"
            ) AS "totalRatings",
            (
              SELECT COUNT(*)::int
              FROM "Job" j
              WHERE j."freelancerId" = u."id" AND j."status"::text = 'COMPLETED'
            ) AS "completedJobsCount",
            (
              SELECT COUNT(*)::int
              FROM "Job" j
              WHERE j."freelancerId" = u."id"
            ) AS "totalJobsCount"
          FROM "User" u
          ${searchFilter}
        )
        SELECT *
        FROM metrics
        ORDER BY ${orderBy}, "id" ASC
        LIMIT ${limit} OFFSET ${offset}
      `),
    ]);
    const totalPages = Math.ceil(total / limit) || 1;

    res.json({
      freelancers: paged.map((user) => ({
        ...user,
        averageScore: Number(user.averageScore.toFixed(2)),
      })),
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
// of the job's asset (like `Job.totalAmount`) rather than raw base units, and
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
  displayName: z.string().trim().max(80).optional(),
  bio: z.string().trim().max(2000).optional(),
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
