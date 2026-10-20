/**
 * reputation.ts
 *
 * POST /api/reputation               — submit a rating (builds reputation.submit tx)
 * GET  /api/reputation/:address      — get aggregate score for an address
 * GET  /api/reputation/:address/ratings — list the individual ratings received
 */

import { Router } from "express";
import { z } from "zod";
import { Contract } from "@stellar/stellar-sdk";
import { Prisma } from "@prisma/client";
import { config } from "../config";
import { buildReputationSubmitArgs } from "../lib/scval";
import { isValidStellarAddress } from "../lib/stellarAddress";
import { REPUTATION_ERROR_MESSAGES } from "../lib/contractErrors";
import { buildTx } from "../lib/soroban";
import { computeWeightedAggregate } from "../lib/reputation";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/errorHandler";

export const reputationRouter = Router();

// POST /api/reputation
export const submitSchema = z.object({
  jobId: z.string(),
  rateeAddress: z.string().refine(isValidStellarAddress, "Invalid Stellar address"),
  score: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
});

reputationRouter.post("/", requireAuth, validate(submitSchema), async (req, res, next) => {
  try {
    const { jobId, rateeAddress, score, comment } = req.body as z.infer<typeof submitSchema>;

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: { client: true, freelancer: true },
    });
    if (!job) throw new AppError(404, "Job not found");
    if (job.status !== "COMPLETED") throw new AppError(400, "Job is not completed");
    if (!job.escrowId) throw new AppError(400, "No on-chain escrow for this job");

    // The caller must be one of the job's two participants, and the ratee must
    // be the *other* one. The reputation contract enforces exactly this
    // (`ReputationError::Unauthorized` / `InvalidRatee`), but the off-chain row
    // is written before the transaction is submitted — so without this check an
    // invalid rating persists even though the chain would reject it (#33).
    const raterAddress = res.locals.stellarAddress;
    const clientAddress = job.client.stellarAddress;
    const freelancerAddress = job.freelancer?.stellarAddress ?? null;

    let expectedRatee: string;
    if (raterAddress === clientAddress) {
      if (!freelancerAddress) throw new AppError(400, "Job has no freelancer to rate");
      expectedRatee = freelancerAddress;
    } else if (freelancerAddress !== null && raterAddress === freelancerAddress) {
      expectedRatee = clientAddress;
    } else {
      throw new AppError(403, "Not a participant of this job");
    }

    if (rateeAddress !== expectedRatee) {
      throw new AppError(400, "Ratee must be the job's other participant");
    }

    const ratee = await prisma.user.findUnique({ where: { stellarAddress: rateeAddress } });
    const rater = await prisma.user.findUnique({ where: { stellarAddress: raterAddress } });
    if (!ratee || !rater) throw new AppError(404, "User not found");

    // Check for a duplicate rating before building anything.
    // The off-chain row mirrors the on-chain state; if it already exists the
    // wallet has already signed and submitted, or a previous attempt persisted
    // a row that was never submitted.  Either way a second attempt is a 409.
    const existingRating = await prisma.rating.findUnique({
      where: { raterId_jobId: { raterId: rater.id, jobId } },
    });
    if (existingRating) {
      throw new AppError(409, "You have already rated this job.");
    }

    // Build reputation.submit tx. The shared builder translates a simulation
    // HostError with the reputation contract's own error table.
    const contract = new Contract(config.REPUTATION_CONTRACT_ID);
    const xdr = await buildTx(
      raterAddress,
      contract.call(
        "submit",
        ...buildReputationSubmitArgs(raterAddress, rateeAddress, job.escrowId, score),
      ),
      { messages: REPUTATION_ERROR_MESSAGES, errorPrefix: "Simulation failed" },
    );

    // Persist off-chain (on-chain record is source of truth; this is for fast reads).
    // Only create the row after the transaction is successfully built so a row
    // cannot exist without a valid XDR to submit.
    let rating;
    try {
      rating = await prisma.rating.create({
        data: { jobId, raterId: rater.id, rateeId: ratee.id, score, comment },
      });
    } catch (err) {
      // A concurrent duplicate-submit can still hit the unique constraint after
      // the `findUnique` guard above (race condition). Map it to 409 rather than
      // letting it bubble as a 500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new AppError(409, "You have already rated this job.");
      }
      throw err;
    }

    res.status(201).json({ rating, xdr });
  } catch (err) {
    next(err);
  }
});

// GET /api/reputation/:address/ratings
//
// The aggregate above answers "how good is this address"; a profile that lets a
// client judge a freelancer also needs the history behind it (issue #69). One
// row per rating received, newest first, each joined to the job it came from so
// the client can open the work it refers to.
reputationRouter.get("/:address/ratings", async (req, res, next) => {
  try {
    const ratings = await prisma.rating.findMany({
      where: { ratee: { stellarAddress: req.params.address } },
      include: {
        job: { select: { id: true, title: true, escrowId: true, status: true } },
        rater: { select: { stellarAddress: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json(ratings);
  } catch (err) {
    next(err);
  }
});

// GET /api/reputation/:address
//
// Returns the same weighted aggregate the reputation contract maintains, not a
// plain mean of the rows (#34). `count` is the number of ratings that counted
// toward it; `totalRatings` remains the number of rows received, so a profile
// can still say "N reviews" while the score matches the chain. `totalScore` and
// `weight` are strings because they are u64 values, exactly as the contract
// returns them.
reputationRouter.get("/:address", async (req, res, next) => {
  try {
    const ratings = await prisma.rating.findMany({
      where: { ratee: { stellarAddress: req.params.address } },
      select: {
        score: true,
        raterId: true,
        job: { select: { totalAmountUsdc: true, asset: true } },
      },
      // Oldest first: the first rating from a rater is the one that counted.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    const aggregate = computeWeightedAggregate(ratings);

    res.json({
      address: req.params.address,
      averageScore:
        aggregate.weight > 0n
          ? Number(aggregate.totalScore) / Number(aggregate.weight)
          : 0,
      totalScore: aggregate.totalScore.toString(),
      weight: aggregate.weight.toString(),
      count: aggregate.count,
      totalRatings: ratings.length,
    });
  } catch (err) {
    next(err);
  }
});
