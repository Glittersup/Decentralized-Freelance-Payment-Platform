/**
 * contractErrors.ts
 *
 * Turns a Soroban host error into something worth returning to an API caller.
 *
 * A contract failure reaches the caller as
 * `HostError: Error(Contract, #N)` inside the simulation response, where `N` is
 * the `#[contracterror]` discriminant from `contracts/interface/src/lib.rs`.
 * Passing that through as an HTTP 400 body tells the client nothing, so the
 * codes the escrow routes can produce are named here — mirroring the same
 * mapping the frontend uses to render contract failures
 * (`frontend/src/lib/errors.ts`).
 *
 * Never throws: an unrecognized message is returned unchanged so a genuinely
 * unexpected failure is still visible rather than swallowed.
 *
 * Contributor Notes:
 * - The discriminant is only unique *per contract*: escrow `#7` is
 *   `ZeroAmount` while dispute `#7` is `EscrowNotDisputed`. A route therefore
 *   passes the map for the contract it is calling, or the client gets a
 *   confidently wrong explanation.
 */

/** `EscrowError` discriminants from `contracts/interface/src/lib.rs`. */
export const ESCROW_ERROR_MESSAGES: Record<number, string> = {
  1: "That escrow doesn't exist.",
  2: "The escrow isn't in a state that allows this action (milestones can only be edited before the escrow is funded).",
  3: "You're not authorized to perform this action.",
  4: "That milestone has already been released.",
  5: "That milestone index is out of range.",
  6: "The escrow hasn't reached its expiry yet, or funds were already released.",
  7: "Amounts must be greater than zero.",
  8: "The milestone list is invalid.",
  9: "The expiry time is invalid.",
  10: "The client and freelancer must be different addresses.",
  11: "This contract is already initialized.",
  12: "This contract isn't initialized yet.",
  13: "The dispute shares don't match the funds held.",
  14: "A numeric overflow occurred.",
  15: "That amount is more than what's left on the milestone.",
  16: "The dispute timeout hasn't been reached yet.",
  17: "The milestone list exceeds the maximum allowed length (20 milestones).",
  18: "This contract is paused.",
};

/** `DisputeError` discriminants from `contracts/dispute/src/lib.rs`. */
export const DISPUTE_ERROR_MESSAGES: Record<number, string> = {
  1: "That dispute doesn't exist.",
  2: "The dispute contract is already initialized.",
  3: "The dispute contract isn't initialized yet.",
  4: "The dispute isn't in a state that allows this action.",
  5: "A dispute has already been raised for this escrow.",
  6: "The escrow doesn't exist.",
  7: "The escrow isn't disputed, so there is nothing to raise — call escrow.open_dispute first.",
  8: "Only the escrow's client or freelancer can raise this dispute.",
  9: "The escrow rejected the resolution (the shares must sum to the funds still held).",
  10: "A numeric overflow occurred.",
  11: "The arbitrator panel is invalid.",
  12: "The approval threshold is invalid.",
  13: "The panel hasn't approved that exact split enough times yet.",
  14: "This contract is paused.",
};

/** `ReputationError` discriminants from `contracts/reputation/src/lib.rs`. */
export const REPUTATION_ERROR_MESSAGES: Record<number, string> = {
  1: "That rating doesn't exist.",
  2: "The reputation contract is already initialized.",
  3: "The reputation contract isn't initialized yet.",
  4: "The score must be between 1 and 5.",
  5: "You have already rated this job.",
  6: "The escrow contract doesn't have that job.",
  7: "The job isn't completed yet, so ratings are not allowed.",
  8: "You're not a participant in this job.",
  9: "The ratee must be the other participant in the job (not the rater).",
  10: "A numeric overflow occurred.",
};

/** Extract the `#N` discriminant from a Soroban contract error, if present. */
export function parseContractErrorCode(message: string): number | null {
  const match = /Error\(Contract,\s*#(\d+)\)/.exec(message);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isInteger(code) ? code : null;
}

/**
 * Map a simulation error to a readable message. Recognized codes in `messages`
 * are translated; anything else (host/crypto failures, RPC errors) keeps its
 * original text.
 *
 * Pass the map for the contract being called — the discriminants overlap
 * between contracts (see the contributor notes above).
 */
export function friendlyContractError(
  message: string,
  messages: Record<number, string> = ESCROW_ERROR_MESSAGES,
): string {
  const code = parseContractErrorCode(message);
  if (code === null) return message;
  return messages[code] ?? message;
}
