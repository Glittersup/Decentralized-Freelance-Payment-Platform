/**
 * useEscrow.ts
 *
 * React hook that wraps all escrow / reputation contract interactions.
 *
 * Every write follows the same pipeline (see lib/stellar.ts):
 *   build → simulate → assemble → sign (Freighter) → submit → poll
 * Reads are signed-free *and wallet-free*: they simulate from the read-only
 * source in lib/stellar.ts, so a shared /jobs/:id or /profile/:address link
 * renders before anyone connects. They reject with a `ContractReadError` whose
 * `kind` separates "not found" from "unavailable" (issue #108).
 *
 * Contributor Notes:
 * - Amounts are i128 stroops (7 decimals). Use `toStroops`/`fromStroops`.
 * - `createAndFund` runs two transactions (create then fund) because the
 *   contracts keep them separate on purpose.
 * - In-flight operations are tracked per target (kind + key), so unrelated
 *   buttons stay enabled and a target cannot be submitted twice.
 * - Every write reports its lifecycle through `useToasts` (building → signing →
 *   confirmed / failed) so feedback survives navigation, and a failure carries
 *   the same mapped contract-error message the inline error shows (issue #60).
 * - A read must never go through `run()`: that helper calls `connect()`. Reads
 *   use `runRead()`, which needs no wallet and never toasts.
 */

import { useCallback, useRef, useState } from "react";
import { TransactionBuilder, SorobanRpc, xdr } from "@stellar/stellar-sdk";
import {
  CONTRACT_ADDRESSES,
  buildContractCall,
  milestonesToScVal,
  networkPassphrase,
  pollTransaction,
  readContract,
  scAddress,
  scString,
  scU32,
  scU64,
  server,
  type MilestoneInput,
} from "../lib/stellar";
import { asReadError, friendlyError, parseContractErrorCode } from "../lib/errors";
import { useToasts } from "./toast-context";
import { useWallet } from "./wallet-context";

export interface MilestoneView {
  amount: bigint;
  released: boolean;
  released_amount: bigint;
  deadline: bigint;
}

export interface EscrowView {
  client: string;
  freelancer: string;
  token: string;
  total_amount: bigint;
  milestones: MilestoneView[];
  status: string;
  created_at: bigint;
  expiry: bigint;
}

export interface ReputationView {
  /** Weight-summed score; average = total_score / weight. */
  total_score: bigint;
  /** Sum of the weights (escrow amounts) behind the counted ratings. */
  weight: bigint;
  count: bigint;
}

/** A submitted transaction's hash plus its decoded return value. */
export interface SubmitResult {
  hash: string;
  result: unknown;
}  /** Result of `createAndFund`; `hash` is the (last) `fund` transaction. */
export interface CreateAndFundResult {
  id: bigint;
  hash: string;
}

/**
 * Result of `openDispute`. `hash` is the `dispute.raise` transaction (the one
 * that actually creates the dispute); `disputeId` is the id the contract
 * returned for it, which is what `POST /api/disputes/:id/sync` records and what
 * `dispute.arbitrate` needs to resolve the dispute.
 */
export interface OpenDisputeResult {
  hash: string;
  disputeId: bigint;
}

/**
 * The kinds of state-changing operation the hook can have in flight. Reads are
 * not here: they are public, so they are not tracked as an operation and never
 * gate a background poll.
 */
export type OpKind = "create" | "release" | "dispute" | "reclaim" | "rate";

const WRITE_KINDS: OpKind[] = ["create", "release", "dispute", "reclaim", "rate"];

/**
 * `scValToNative` decodes the escrow's unit-enum `status` as a one-element array
 * (`["Active"]`), while `EscrowView` promises a string and every caller compares
 * it to one. Left unwrapped, the page's status badge and action gating
 * (`status === "Active"`) silently never match a real, on-chain escrow, so a
 * live client would never see the Release button.
 *
 * Normalizing at the read boundary keeps the view honest for every consumer,
 * and tolerates a string from an already-normalized source.
 */
export function normalizeEscrowView(view: EscrowView): EscrowView {
  const status: unknown = view.status;
  if (Array.isArray(status) && status.length === 1 && typeof status[0] === "string") {
    return { ...view, status: status[0] };
  }
  return view;
}

/**
 * The last operation that failed, so a caller can react to a specific contract
 * error (e.g. hide the rating form when the contract returns `AlreadyRated`)
 * without re-parsing the friendly message.
 */
export interface FailureInfo {
  kind: OpKind;
  /** The `#[contracterror]` discriminant, or `null` for a non-contract error. */
  code: number | null;
}

export function useEscrow() {
  const { publicKey, connect, sign } = useWallet();
  const { start: startToast, update: updateToast } = useToasts();
  const [pendingOps, setPendingOps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastFailure, setLastFailure] = useState<FailureInfo | null>(null);
  // Source of truth for in-flight ops; the state mirrors it for rendering, and
  // the ref stays current inside async callbacks (e.g. the poll in JobDetail).
  const pendingRef = useRef<Set<string>>(new Set());

  const syncPending = useCallback(() => {
    setPendingOps([...pendingRef.current]);
  }, []);

  /** Run an operation, guarding against a duplicate start for the same target. */
  const run = useCallback(
    async <T>(
      kind: OpKind,
      key: string,
      fn: (pk: string) => Promise<T>,
    ): Promise<T | undefined> => {
      const id = `${kind}:${key}`;
      if (pendingRef.current.has(id)) return undefined; // double-submit guard

      pendingRef.current.add(id);
      syncPending();
      setError(null);
      setLastFailure(null);
      try {
        const pk = publicKey ?? (await connect());
        if (!pk) throw new Error("Wallet not connected");
        return await fn(pk);
      } catch (e) {
        setError(friendlyError(e));
        setLastFailure({
          kind,
          code: parseContractErrorCode(e instanceof Error ? e.message : String(e)),
        });
        return undefined;
      } finally {
        pendingRef.current.delete(id);
        syncPending();
      }
    },
    [publicKey, connect, syncPending],
  );

  /** Is an operation in flight? Narrow by `kind` and/or exact `key`. */
  const isPending = useCallback(
    (kind?: OpKind, key?: string) => {
      if (!kind) return pendingOps.length > 0;
      if (key === undefined) return pendingOps.some((id) => id.startsWith(`${kind}:`));
      return pendingOps.includes(`${kind}:${key}`);
    },
    [pendingOps],
  );

  /** Is any state-changing write pending? Used to pause background polling. */
  const hasPendingWrite = useCallback(
    () => [...pendingRef.current].some((id) => WRITE_KINDS.some((k) => id.startsWith(`${k}:`))),
    [],
  );

  /**
   * Run a public read. `escrow.get`, `escrow.dispute_deadline` and
   * `reputation.get_aggregate` are open views: they need no wallet, so this
   * bypasses `run()` and its `connect()` call entirely.
   *
   * Failures are normalized to `ContractReadError` and left to the caller — each
   * page renders its own not-found/unavailable state — and stale write errors are
   * cleared, because a read succeeding proves the network is reachable.
   */
  const runRead = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    setError(null);
    try {
      return await fn();
    } catch (e) {
      throw asReadError(e);
    }
  }, []);

  /**
   * Submit a state-changing contract call. Returns the transaction hash and the
   * decoded return value so callers can link to the explorer.
   *
   * The transaction's progress is reported as one toast that advances in place,
   * so the three stages the user cares about — building, waiting for the wallet
   * to sign, and the outcome — appear without stacking up. On failure the toast
   * carries the mapped contract-error message (the same one the inline error
   * shows) and the error still propagates to `run`.
   */
  const submit = useCallback(
    async (
      pk: string,
      contractId: string,
      method: string,
      args: xdr.ScVal[],
      label: string,
    ): Promise<SubmitResult> => {
      const toastId = startToast(`Building ${label} transaction…`);
      try {
        const built = await buildContractCall(pk, contractId, method, args);
        updateToast(toastId, "signing", `Awaiting signature for ${label}…`);
        const signed = await sign(built.xdr);
        const tx = TransactionBuilder.fromXDR(signed, networkPassphrase);
        const sent = await server.sendTransaction(tx);
        if (sent.status === "ERROR") {
          throw new Error(`Transaction rejected: ${JSON.stringify(sent.errorResult)}`);
        }
        const receipt = await pollTransaction(sent.hash);
        if (receipt.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
          throw new Error(`Transaction ${sent.hash} failed (${receipt.status})`);
        }
        updateToast(toastId, "confirmed", `${label} confirmed`, sent.hash);
        // The return value does not survive submission, so use the simulated one.
        return { hash: sent.hash, result: built.result };
      } catch (e) {
        updateToast(toastId, "failed", friendlyError(e));
        throw e;
      }
    },
    [sign, startToast, updateToast],
  );

  /**
   * Create an escrow and immediately fund it, paying in `token` (a SAC address).
   * Returns the id and the fund hash.
   */
  const createAndFund = useCallback(
    (freelancer: string, token: string, milestones: MilestoneInput[], expiry: bigint) =>
      run("create", freelancer, async (pk): Promise<CreateAndFundResult> => {
        const escrow = CONTRACT_ADDRESSES.escrow;
        const created = await submit(pk, escrow, "create", [
          scAddress(pk),
          scAddress(freelancer),
          scAddress(token),
          milestonesToScVal(milestones),
          scU64(expiry),
        ], "create escrow");
        const id = BigInt(created.result as bigint | number | string);
        const funded = await submit(pk, escrow, "fund", [scU64(id)], "fund escrow");
        return { id, hash: funded.hash };
      }),
    [run, submit],
  );

  /** Client releases a milestone to the freelancer. */
  const releaseMilestone = useCallback(
    (escrowId: bigint, milestoneIndex: number) =>
      run("release", `${escrowId}:${milestoneIndex}`, (pk) =>
        submit(pk, CONTRACT_ADDRESSES.escrow, "release_milestone", [
          scU64(escrowId),
          scU32(milestoneIndex),
        ], "release milestone"),
      ),
    [run, submit],
  );

  /**
   * Either party freezes the escrow by opening a dispute, then raises it.
   *
   * Two transactions on two contracts, and the order is not interchangeable:
   *
   *   1. `escrow.open_dispute(escrow_id, initiator)` — escrow: Active → Disputed.
   *   2. `dispute.raise(escrow_id, escrow_contract, raised_by, reason)` — creates
   *      the dispute the panel rules on and returns its id.
   *
   * `open_dispute` alone leaves the escrow frozen with no on-chain dispute, so
   * `dispute.arbitrate` has no id to resolve and `POST /api/disputes/:id/resolve`
   * is unreachable (issue #86). Raising first is not an option: `dispute.raise`
   * cross-calls the escrow and refuses while it is not yet `Disputed`
   * (`EscrowNotDisputed`).
   *
   * The reason goes to the contract, which stores it, and the returned id is
   * handed back so the caller can record it against the off-chain row.
   */
  const openDispute = useCallback(
    (escrowId: bigint, reason: string) =>
      run("dispute", `${escrowId}`, async (pk): Promise<OpenDisputeResult> => {
        await submit(pk, CONTRACT_ADDRESSES.escrow, "open_dispute", [
          scU64(escrowId),
          scAddress(pk),
        ], "open dispute");
        const raised = await submit(pk, CONTRACT_ADDRESSES.dispute, "raise", [
          scU64(escrowId),
          scAddress(CONTRACT_ADDRESSES.escrow),
          scAddress(pk),
          scString(reason),
        ], "raise dispute");
        // The id comes from the simulation of the call that was just submitted:
        // the contract's return value does not survive submission, and it is the
        // only way to learn the id without waiting for the indexer to see the
        // `raised` event.
        return {
          hash: raised.hash,
          disputeId: BigInt(raised.result as bigint | number | string),
        };
      }),
    [run, submit],
  );

  /**
   * The client reclaims a `Disputed` escrow once the dispute timelock has
   * passed with no ruling (the panel-never-rules escape hatch).
   *
   * `escrow.reclaim_after_dispute_timeout(escrow_id)` requires the client's auth
   * on-chain and rejects the call while the escrow is not `Disputed`
   * (`InvalidStatus`) or before the deadline (`DisputeTimeoutNotReached`). The
   * deadline is the `dispute_deadline` read below. On success the escrow moves
   * to `Refunded`.
   */
  const reclaimDisputed = useCallback(
    (escrowId: bigint) =>
      run("reclaim", `${escrowId}`, (pk) =>
        submit(pk, CONTRACT_ADDRESSES.escrow, "reclaim_after_dispute_timeout", [
          scU64(escrowId),
        ], "reclaim funds"),
      ),
    [run, submit],
  );

  /**
   * The client reclaims an `Active` escrow that has passed its safety expiry.
   *
   * `escrow.reclaim_expired(escrow_id)` requires the client's auth on-chain and
   * rejects the call while the escrow is not `Active` (`InvalidStatus`) or before
   * the expiry (`NotExpired`). On success the escrow moves to `Refunded` and any
   * unreleased funds return to the client — earlier partial releases are not
   * clawed back.
   */
  const reclaimExpired = useCallback(
    (escrowId: bigint) =>
      run("reclaim", `${escrowId}`, (pk) =>
        submit(pk, CONTRACT_ADDRESSES.escrow, "reclaim_expired", [
          scU64(escrowId),
        ], "reclaim expired escrow"),
      ),
    [run, submit],
  );

  /**
   * Rate the counterparty once the escrow is completed.
   *
   * `reputation.submit(rater, ratee, escrow_id, score)` verifies on-chain that
   * the job finished and that the two addresses are its participants, so the UI
   * only needs to send the score. The contract rejects a second rating from the
   * same wallet with `AlreadyRated` (code 5), which surfaces on `lastFailure`.
   */
  const submitRating = useCallback(
    (escrowId: bigint, ratee: string, score: number) =>
      run("rate", `${escrowId}:${ratee}`, (pk) =>
        submit(pk, CONTRACT_ADDRESSES.reputation, "submit", [
          scAddress(pk),
          scAddress(ratee),
          scU64(escrowId),
          scU32(score),
        ], "submit rating"),
      ),
    [run, submit],
  );

  /** Read a single escrow (view). No wallet needed; rejects with a typed error. */
  const getEscrow = useCallback(
    (escrowId: bigint) =>
      runRead(async () =>
        normalizeEscrowView(
          await readContract<EscrowView>(CONTRACT_ADDRESSES.escrow, "get", [scU64(escrowId)]),
        ),
      ),
    [runRead],
  );

  /**
   * Read the dispute timelock deadline (unix seconds) for an escrow (view).
   *
   * Set when `open_dispute` runs; the client may reclaim once the ledger clock
   * is past it. Rejects (`unknown`) for an escrow that never opened one.
   */
  const getDisputeDeadline = useCallback(
    (escrowId: bigint) =>
      runRead(() =>
        readContract<bigint>(CONTRACT_ADDRESSES.escrow, "dispute_deadline", [
          scU64(escrowId),
        ]),
      ),
    [runRead],
  );

  /** Read a user's reputation aggregate (view). No wallet needed. */
  const getReputation = useCallback(
    (address: string) =>
      runRead(() =>
        readContract<ReputationView>(CONTRACT_ADDRESSES.reputation, "get_aggregate", [
          scAddress(address),
        ]),
      ),
    [runRead],
  );

  return {
    createAndFund,
    releaseMilestone,
    openDispute,
    reclaimDisputed,
    reclaimExpired,
    submitRating,
    getEscrow,
    getDisputeDeadline,
    getReputation,
    pendingOps,
    isPending,
    hasPendingWrite,
    error,
    lastFailure,
  };
}
