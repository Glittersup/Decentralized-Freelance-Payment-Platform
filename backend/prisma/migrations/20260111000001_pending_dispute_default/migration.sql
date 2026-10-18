-- AlterTable
-- New rows start PENDING; `/:id/sync` or the indexer's `raised` handler moves
-- them to RAISED once the on-chain id is known.
ALTER TABLE "Dispute" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- Existing rows that never got an on-chain id are exactly the phantom disputes
-- #32 describes: built but never submitted. They must not be reported as live.
UPDATE "Dispute" SET "status" = 'PENDING' WHERE "onChainId" IS NULL;
