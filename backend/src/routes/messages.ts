/**
 * messages.ts
 *
 * The job-scoped conversation between a job's client and its freelancer.
 *
 * Routes:
 *   GET  /api/messages/unread         — unread counts per job, plus a total
 *   GET  /api/messages/:jobId         — the latest messages, oldest first
 *   POST /api/messages/:jobId         — send a message
 *   POST /api/messages/:jobId/read    — mark the other party's messages read
 *
 * Privacy: a message is readable only by the two participants of its job. Every
 * route resolves the caller against `job.client` / `job.freelancer` before it
 * touches a `Message` row, so a third party gets a 403 even by guessing a job
 * id. Nothing here trusts a client-supplied sender either: the sender id is
 * taken from the job row that the caller just matched against.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/errorHandler";

export const messagesRouter = Router();

/** A message body is a chat line, not a document. */
export const sendMessageSchema = z.object({
  body: z.string().trim().min(1, "A message cannot be empty").max(2000),
});

const getMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().min(1).optional(),
});

/** The job plus whichever of its two participants the caller is. */
interface ParticipantJob {
  id: string;
  clientId: string;
  freelancerId: string | null;
  isClient: boolean;
}

/**
 * Load a job and assert the caller is one of its participants.
 *
 * Throws 404 for a missing job and 403 otherwise — the same pair for "no such
 * job" and "not your job", so the response cannot be used to probe which job
 * ids exist with only the id.
 */
async function loadParticipantJob(jobId: string, address: string): Promise<ParticipantJob> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { client: true, freelancer: true },
  });
  if (!job) throw new AppError(404, "Job not found");

  const isClient = job.client.stellarAddress === address;
  const isFreelancer = job.freelancer?.stellarAddress === address;
  if (!isClient && !isFreelancer) {
    throw new AppError(403, "Only this job's client and freelancer can see its messages");
  }

  return { id: job.id, clientId: job.clientId, freelancerId: job.freelancerId, isClient };
}

/**
 * The messages that are unread *for* `address`: sent by the other party, in a
 * job the address participates in, and not yet read.
 */
function unreadFor(address: string) {
  return {
    readAt: null,
    sender: { stellarAddress: { not: address } },
    job: {
      OR: [
        { client: { stellarAddress: address } },
        { freelancer: { stellarAddress: address } },
      ],
    },
  };
}

// GET /api/messages/unread
//
// Registered before `/:jobId` so "unread" is not read as a job id.
messagesRouter.get("/unread", requireAuth, async (_req, res, next) => {
  try {
    const address = res.locals.stellarAddress;

    // Grouped in the database rather than counted in JS: the response is one
    // entry per job, so an account with a long unread history does not have to
    // ship every row to be counted.
    const rows = await prisma.message.groupBy({
      by: ["jobId"],
      where: unreadFor(address),
      _count: { _all: true },
    });

    const byJob = rows.map((row) => ({ jobId: row.jobId, count: row._count._all }));
    res.json({
      total: byJob.reduce((sum, entry) => sum + entry.count, 0),
      byJob,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/messages/:jobId
messagesRouter.get("/:jobId", requireAuth, async (req, res, next) => {
  try {
    const address = res.locals.stellarAddress;
    await loadParticipantJob(req.params.jobId, address);

    const query = getMessagesQuerySchema.safeParse(req.query);
    if (!query.success) throw new AppError(400, "Invalid message pagination parameters");
    const { limit, before } = query.data;

    const rows = await prisma.message.findMany({
      where: { jobId: req.params.jobId },
      ...(before ? { cursor: { id: before }, skip: 1 } : {}),
      take: limit,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { sender: { select: { stellarAddress: true, displayName: true } } },
    });
    res.json(rows.reverse());
  } catch (err) {
    next(err);
  }
});

// POST /api/messages/:jobId
messagesRouter.post("/:jobId", requireAuth, validate(sendMessageSchema), async (req, res, next) => {
  try {
    const address = res.locals.stellarAddress;
    const { body } = req.body as z.infer<typeof sendMessageSchema>;
    const job = await loadParticipantJob(req.params.jobId, address);

    // The sender is whoever the caller just matched: never a body field.
    const senderId = job.isClient ? job.clientId : job.freelancerId;
    if (!senderId) throw new AppError(403, "Only this job's client and freelancer can post here");

    const message = await prisma.message.create({
      data: { jobId: job.id, senderId, body },
    });
    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

// POST /api/messages/:jobId/read
//
// Scoped to the *other* party's messages, so a user can never mark their own
// message as read-on-behalf-of the recipient.
messagesRouter.post("/:jobId/read", requireAuth, async (req, res, next) => {
  try {
    const address = res.locals.stellarAddress;
    await loadParticipantJob(req.params.jobId, address);

    const result = await prisma.message.updateMany({
      where: {
        jobId: req.params.jobId,
        readAt: null,
        sender: { stellarAddress: { not: address } },
      },
      data: { readAt: new Date() },
    });
    res.json({ markedRead: result.count });
  } catch (err) {
    next(err);
  }
});
