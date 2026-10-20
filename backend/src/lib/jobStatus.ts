import type { JobStatus } from "@prisma/client";

/**
 * The off-chain status a funded escrow mirrors.
 *
 * Two writers record the same on-chain transition: the frontend calls
 * `POST /api/escrow/sync/:jobId` after `create` + `fund` confirm, and the
 * indexer applies the contract's `funded` event (`handleFunded`). They used to
 * disagree — the route wrote `FUNDED`, the indexer wrote `ACTIVE` — so a job's
 * status flipped back and forth depending on which writer ran last, and a
 * replayed event could undo the route's write (issue #43).
 *
 * `ACTIVE` is the one that survives a replay: the indexer re-applies `funded`
 * events whenever its cursor is rewound, so the status it writes has to be the
 * canonical one. Both writers now read this constant, so they cannot drift
 * again.
 *
 * `FUNDED` stays in `JobStatus` because existing rows and older clients may
 * still carry it, but no writer produces it any more.
 */
export const FUNDED_JOB_STATUS: JobStatus = "ACTIVE";
