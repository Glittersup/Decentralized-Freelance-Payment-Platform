/**
 * errors.ts
 *
 * Turns raw contract/SDK errors into friendly, user-facing messages.
 *
 * Soroban surfaces a contract error as `HostError: Error(Contract, #N)`, where
 * `N` is the `#[contracterror]` discriminant from
 * `contracts/{interface,dispute,reputation}/src/lib.rs`. Callers should show the
 * mapped message when one exists and otherwise fall back to the original text —
 * this helper never throws and never hides an error.
 *
 * Note on codes: the wave-issue text lists `#7 NotExpired`, but the interface
 * enum defines `NotExpired = 6` and `ZeroAmount = 7`. These messages follow the
 * code (`contracts/interface/src/lib.rs`), which is the source of truth.
 *
 * Contributor Notes:
 * - Codes overlap between contracts (e.g. escrow `#4` is
 *   `MilestoneAlreadyReleased` but reputation `#4` is `InvalidScore`), so a few
 *   messages describe both meanings rather than guessing the contract.
 * - Public reads get a `ReadFailureKind` on top of the message, so a page can
 *   tell "this record does not exist" apart from "Stellar could not be
 *   reached" instead of blaming the link for every failure. See
 *   `classifyReadFailure`.
 */

const CONTRACT_ERROR_MESSAGES: Record<number, string> = {
  // EscrowError / DisputeError / ReputationError
  1: "That record was not found.",
  2: "This action isn't allowed right now — it may already be initialized.",
  3: "You're not authorized to perform this action.",
  4: "This milestone has already been released, or the rating is out of range (1–5).",
  5: "That milestone index is out of range, or you've already rated this job.",
  6: "This escrow hasn't reached its expiry yet, or the escrow was not found.",
  7: "Amounts must be greater than zero, or the job isn't completed yet.",
  8: "The milestone list is invalid, or you're not a party to this job.",
  9: "The expiry time is invalid, or the rated address is incorrect.",
  10: "The client and freelancer must be different addresses.",
  11: "This contract is already initialized, or the address isn't on the arbitrator panel.",
  12: "This contract isn't initialized yet, or the approval threshold is invalid.",
  13: "The shares don't match the funds held, or the panel hasn't approved enough votes.",
  14: "A numeric overflow occurred, or the contract is paused.",
  15: "That amount is more than what's left on the milestone.",
  16: "The dispute timeout hasn't been reached yet.",
  18: "This contract is paused.",
};

/** Extract the `#N` discriminant from a Soroban contract error, if present. */
export function parseContractErrorCode(message: string): number | null {
  const match = /Error\(Contract,\s*#(\d+)\)/.exec(message);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isInteger(code) ? code : null;
}

/**
 * Map an error to a friendly message. Recognized contract codes are translated;
 * everything else (network errors, rejected signatures, unknown codes) keeps its
 * original message. Never throws.
 */
export function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = parseContractErrorCode(raw);
  if (code !== null) {
    const message = CONTRACT_ERROR_MESSAGES[code];
    if (message) return message;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Read failures
// ---------------------------------------------------------------------------

/**
 * Why a public read failed, at the level of detail a page can act on:
 *
 * - `not-found`   – the contract answered "no such record", or the id/address in
 *                   the URL cannot exist at all. The link is the problem.
 * - `unavailable` – there was no answer to read: RPC/network failure, a missing
 *                   contract id, or an unreadable read-only source account. The
 *                   link is fine; retrying or fixing configuration helps.
 * - `unknown`     – the contract rejected the call for another reason (e.g. it
 *                   is not initialized); the raw message is worth showing.
 */
export type ReadFailureKind = "not-found" | "unavailable" | "unknown";

/** A read-only contract call that failed, carrying a machine-readable kind. */
export class ContractReadError extends Error {
  readonly kind: ReadFailureKind;

  constructor(kind: ReadFailureKind, message: string) {
    super(message);
    this.name = "ContractReadError";
    this.kind = kind;
  }
}

/** Failures that mean "no usable answer from the network", not "bad record". */
const UNAVAILABLE_PATTERNS = [
  /failed to fetch/i,
  /fetch failed/i,
  /load failed/i,
  /network ?error/i,
  /timed? ?out|timeout/i,
  /econnrefused|econnreset|enotfound|eai_again|socket hang up/i,
  /connection (?:refused|closed|reset)/i,
  /http (?:408|429|5\d\d)/i,
  /not configured/i,
  // A malformed contract id comes from a bad VITE_*_CONTRACT_ID, not a bad link.
  /invalid contract id/i,
];

/** Failures that mean the id/address the caller asked for cannot exist. */
const INVALID_INPUT_PATTERNS = [
  /unsupported address type/i,
  /invalid address/i,
  /invalid strkey/i,
  /invalid public key/i,
];

/**
 * Classify a failed read without hiding it: contract codes win, then SDK input
 * validation, then transport failures; anything else stays `unknown` so its
 * message is surfaced verbatim.
 */
export function classifyReadFailure(error: unknown): ReadFailureKind {
  if (error instanceof ContractReadError) return error.kind;
  const raw = error instanceof Error ? error.message : String(error);

  const code = parseContractErrorCode(raw);
  if (code === 1) return "not-found";
  // NotInitialized means this deployment cannot answer reads yet.
  if (code === 12) return "unavailable";
  if (code !== null) return "unknown";

  if (INVALID_INPUT_PATTERNS.some((re) => re.test(raw))) return "not-found";
  if (UNAVAILABLE_PATTERNS.some((re) => re.test(raw))) return "unavailable";
  return "unknown";
}

/** Normalize anything a read threw into a `ContractReadError`. */
export function asReadError(error: unknown): ContractReadError {
  if (error instanceof ContractReadError) return error;
  return new ContractReadError(classifyReadFailure(error), friendlyError(error));
}

/**
 * User-facing copy for a read failure. `subject` is what could not be read,
 * e.g. "job #12" or "this reputation".
 */
export function describeReadFailure(
  kind: ReadFailureKind,
  subject: string,
): string {
  switch (kind) {
    case "not-found":
      return `Couldn't find ${subject}. It may not exist on this network — check the link.`;
    case "unavailable":
      return `Couldn't reach Stellar to read ${subject}. This is a network or configuration problem, not a bad link — try again.`;
    default:
      return `Reading ${subject} failed for an unexpected reason.`;
  }
}
