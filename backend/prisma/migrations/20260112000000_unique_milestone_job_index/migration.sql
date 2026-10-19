-- Step 1: Re-point any deliverables attached to duplicate milestones to the surviving milestone.
-- The surviving row is: RELEASED first, then highest releasedAmount, then latest createdAt, then lowest id.
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
        "createdAt" DESC,
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
        "createdAt" DESC,
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
