/**
 * escrowArgs.ts
 *
 * Explicit ScVal construction for the escrow contract's `create` call.
 *
 * `nativeToScVal` on a plain object does not reliably produce the contract's
 * `Milestone` struct (a ScMap keyed by field-name symbols), and re-wrapping
 * already-built ScVals double-encodes them. Build the args by hand here instead,
 * matching `contracts/interface/src/lib.rs`:
 *
 *   Milestone { amount: i128, released: bool, released_amount: i128, deadline: u64 }
 *   create(client: Address, freelancer: Address, token: Address,
 *          milestones: Vec<Milestone>, expiry: u64)
 *
 * The frontend's `milestonesToScVal` mirrors this shape.
 */

import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

export interface MilestoneArg {
  amount: bigint;
  deadline: bigint;
  released?: boolean;
  releasedAmount?: bigint;
}

/**
 * Encode one milestone as the contract's `Milestone` struct.
 *
 * The map entries are emitted in **ascending key order** (`amount`, `deadline`,
 * `released`, `released_amount`) — the order the Rust SDK produces for a
 * `#[contracttype]` struct and the order `nativeToScVal` sorts to, because the
 * Soroban runtime expects map keys in sorted order. Hand-built maps in field
 * declaration order decode fine locally (`scValToNative` does not care) but can
 * be rejected on-chain after the fee is spent, so the sorted order is part of
 * the contract-facing layout, not a detail. See `escrowArgs.test.ts`, which
 * pins both the XDR bytes and the equivalence with `nativeToScVal`.
 */
export function milestoneToScVal(m: MilestoneArg): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("amount"),
      val: nativeToScVal(m.amount, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("deadline"),
      val: nativeToScVal(m.deadline, { type: "u64" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("released"),
      val: xdr.ScVal.scvBool(m.released ?? false),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("released_amount"),
      val: nativeToScVal(m.releasedAmount ?? 0n, { type: "i128" }),
    }),
  ]);
}

/** Encode a list of milestones as the contract's `Vec<Milestone>`. */
export function milestonesToScVal(milestones: MilestoneArg[]): xdr.ScVal {
  return xdr.ScVal.scvVec(milestones.map(milestoneToScVal));
}

export interface CreateArgsInput {
  client: string;
  freelancer: string;
  token: string;
  milestones: MilestoneArg[];
  expiry: bigint;
}

/**
 * Build the positional ScVal arguments for `escrow.create`, with the exact types
 * the contract expects. Pass the result straight to `contract.call("create", ...args)`.
 */
export function buildCreateArgs(input: CreateArgsInput): xdr.ScVal[] {
  return [
    Address.fromString(input.client).toScVal(),
    Address.fromString(input.freelancer).toScVal(),
    Address.fromString(input.token).toScVal(),
    milestonesToScVal(input.milestones),
    nativeToScVal(input.expiry, { type: "u64" }),
  ];
}

export interface UpdateMilestonesArgsInput {
  escrowId: bigint;
  milestones: MilestoneArg[];
}

/**
 * Build the arguments for `escrow.update_milestones(escrow_id, milestones)`.
 *
 * The call replaces the whole breakdown, so the new milestone list has to be
 * encoded exactly the way `create` encodes it — same struct, same field order.
 */
export function buildUpdateMilestonesArgs(input: UpdateMilestonesArgsInput): xdr.ScVal[] {
  return [
    nativeToScVal(input.escrowId, { type: "u64" }),
    milestonesToScVal(input.milestones),
  ];
}
