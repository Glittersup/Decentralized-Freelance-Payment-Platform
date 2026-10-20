import { Router } from "express";
import { prisma } from "../db";
import { config } from "../config";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/errorHandler";
import { createDeliverableSchema } from "../lib/schemas";
import { isListed, parseList } from "../lib/access";

export const milestonesRouter = Router();

// POST /api/milestones/:id/deliverables
milestonesRouter.post(
  "/:id/deliverables",
  requireAuth,
  validate(createDeliverableSchema),
  async (req, res, next) => {
    try {
      const milestone = await prisma.milestone.findUnique({
        where: { id: req.params.id },
        include: { job: { include: { freelancer: true, client: true } } },
      });
      if (!milestone) throw new AppError(404, "Milestone not found");

      if (milestone.job.freelancer?.stellarAddress !== res.locals.stellarAddress) {
        throw new AppError(403, "Only the assigned freelancer can attach deliverables to this milestone");
      }

      if (milestone.status === "RELEASED") {
        throw new AppError(400, "Cannot attach deliverables to an already released milestone");
      }

      const user = await prisma.user.upsert({
        where: { stellarAddress: res.locals.stellarAddress },
        create: { stellarAddress: res.locals.stellarAddress },
        update: {},
      });

      const { fileName, fileUrl, fileSize, fileType, description } = req.body as {
        fileName: string;
        fileUrl: string;
        fileSize?: number;
        fileType?: string;
        description?: string;
      };

      const deliverable = await prisma.deliverable.create({
        data: {
          milestoneId: milestone.id,
          fileName,
          fileUrl,
          fileSize,
          fileType,
          description,
          uploadedById: user.id,
        },
        include: { uploadedBy: true },
      });

      res.status(201).json(deliverable);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/milestones/:id/deliverables
milestonesRouter.get("/:id/deliverables", requireAuth, async (req, res, next) => {
  try {
    const milestone = await prisma.milestone.findUnique({
      where: { id: req.params.id },
      include: { job: { include: { freelancer: true, client: true } } },
    });
    if (!milestone) throw new AppError(404, "Milestone not found");

    const stellarAddress = res.locals.stellarAddress;
    const isClient = milestone.job.client?.stellarAddress === stellarAddress;
    const isFreelancer = milestone.job.freelancer?.stellarAddress === stellarAddress;
    const isArbitrator = isListed(stellarAddress, parseList(config.ARBITRATOR_ADDRESSES));

    if (!isClient && !isFreelancer && !isArbitrator) {
      throw new AppError(403, "Access denied: you must be the client, freelancer, or arbitrator");
    }

    const deliverables = await prisma.deliverable.findMany({
      where: { milestoneId: req.params.id },
      include: { uploadedBy: true },
      orderBy: { createdAt: "desc" },
    });

    res.json(deliverables);
  } catch (err) {
    next(err);
  }
});
