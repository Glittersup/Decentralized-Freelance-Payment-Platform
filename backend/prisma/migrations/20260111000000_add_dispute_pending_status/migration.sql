-- AlterEnum
-- A dispute row is written (for its reason) before `dispute.raise` confirms.
-- Until the on-chain id exists it is an intent, not a dispute, and the API hides
-- it; PENDING names that state explicitly (#32).
ALTER TYPE "DisputeStatus" ADD VALUE 'PENDING';
