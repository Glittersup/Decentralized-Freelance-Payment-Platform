-- Asset-neutral amount columns (issue #41).
--
-- `Job.totalAmountUsdc` and `Milestone.amountUsdc` were named for USDC, but
-- `Job.asset` can be XLM or any registered SAC, so an XLM job stored its
-- amounts in a column called "Usdc". RENAME COLUMN keeps every existing row and
-- its value; no data is copied or dropped.
ALTER TABLE "Job" RENAME COLUMN "totalAmountUsdc" TO "totalAmount";
ALTER TABLE "Milestone" RENAME COLUMN "amountUsdc" TO "amount";
