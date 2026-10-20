-- Step 1: Re-point any deliverables attached to duplicate milestones to the surviving milestone.
-- The surviving row is: RELEASED first, then highest releasedAmount, then latest releasedAt, then lowest id.
--
-- `Milestone` has no `createdAt` column (see schema.prisma: only deadline and
-- releasedAt are timestamps), so ordering by it made this migration fail on a
-- fresh database with `column "createdAt" does not exist` — which is what the
-- CI "Apply migrations" step runs. releasedAt is the date this migration
-- actually means: the milestone that was released most recently wins.
WITH ranked AS (
  SELECT
    id,
    "jobId",
    index,
    ROW_NUMBER() OVER (
      PARTITION BY "jobId", index
      ORDER BY
        CASE WHEN status = 'RELEASED' THEN 0 ELSE 1 END,
        "releasedAmount" DESC,
        "releasedAt" DESC NULLS LAST,
        id ASC
    ) as rn
  FROM "Milestone"
),
survivors AS (
  SELECT id as survivor_id, "jobId", index
  FROM ranked
  WHERE rn = 1
),
duplicates AS (
  SELECT id as duplicate_id, "jobId", index
  FROM ranked
  WHERE rn > 1
)
UPDATE "Deliverable" d
SET "milestoneId" = s.survivor_id
FROM duplicates dup
JOIN survivors s ON dup."jobId" = s."jobId" AND dup.index = s.index
WHERE d."milestoneId" = dup.duplicate_id;

-- Step 2: Delete duplicate milestones so existing data satisfies the constraint
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "jobId", index
      ORDER BY
        CASE WHEN status = 'RELEASED' THEN 0 ELSE 1 END,
        "releasedAmount" DESC,
        "releasedAt" DESC NULLS LAST,
        id ASC
    ) as rn
  FROM "Milestone"
)
DELETE FROM "Milestone"
WHERE id IN (
  SELECT id FROM ranked WHERE rn > 1
);

-- Step 3: CreateIndex
CREATE UNIQUE INDEX "Milestone_jobId_index_key" ON "Milestone"("jobId", "index");
