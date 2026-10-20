import { describe, it, expect } from "vitest";
import { Keypair, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  buildCreateArgs,
  buildUpdateMilestonesArgs,
  milestonesToScVal,
} from "../lib/escrowArgs";

/**
 * The exact XDR `milestonesToScVal` must produce for this known input, pinned
 * byte-for-byte. A round-trip through `scValToNative` cannot catch the two
 * ways this encoding has silently broken real transactions:
 *
 * - **Map key order.** The Soroban runtime expects `ScMap` keys in ascending
 *   order (that is what the Rust SDK emits for a `#[contracttype]` struct and
 *   what base-layer `nativeToScVal` sorts to). Keys in field-declaration order
 *   decode fine locally but can be rejected on-chain, after the fee is spent.
 * - **Key type.** The contract's struct lookup is by `Symbol`; keys built as
 *   `ScVal.scvString` (which is what `nativeToScVal` produces for a plain JS
 *   object) decode to the same JS values and therefore pass a round-trip, but
 *   the contract cannot read the fields from them.
 *
 * The pinned vector has symbol keys in sorted order: amount, deadline,
 * released, released_amount. Regenerate it only for a deliberate, reviewed
 * change to the contract's `Milestone` layout.
 */
const KNOWN_MILESTONES_XDR =
  "AAAAEAAAAAEAAAACAAAAEQAAAAEAAAAEAAAADwAAAAZhbW91bnQAAAAAAAoAAAAAAA" +
  "AAAAAAAAAAAAEsAAAADwAAAAhkZWFkbGluZQAAAAUAAAAAAAAAAAAAAA8AAAAIcmVs" +
  "ZWFzZWQAAAAAAAAAAAAAAA8AAAAPcmVsZWFzZWRfYW1vdW50AAAAAAoAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAEQAAAAEAAAAEAAAADwAAAAZhbW91bnQAAAAAAAoAAAAAAAAAAAAA" +
  "AAAAAAK8AAAADwAAAAhkZWFkbGluZQAAAAUAAAAAZVPxAAAAAA8AAAAIcmVsZWFzZW" +
  "QAAAAAAAAAAAAAAA8AAAAPcmVsZWFzZWRfYW1vdW50AAAAAAoAAAAAAAAAAAAAAAAA" +
  "AAAA";

const KNOWN_MILESTONES = [
  { amount: 300n, deadline: 0n },
  { amount: 700n, deadline: 1_700_000_000n },
];

describe("milestonesToScVal", () => {
  it("encodes the known input to the exact XDR the contract expects", () => {
    expect(milestonesToScVal(KNOWN_MILESTONES).toXDR("base64")).toBe(
      KNOWN_MILESTONES_XDR,
    );
  });

  it("keys each milestone map by Symbol, in ascending field-name order", () => {
    const [first] = milestonesToScVal(KNOWN_MILESTONES).vec() ?? [];
    const entries = first?.map() ?? [];

    expect(entries.map((entry) => entry.key().switch().name)).toEqual([
      "scvSymbol",
      "scvSymbol",
      "scvSymbol",
      "scvSymbol",
    ]);
    expect(entries.map((entry) => scValToNative(entry.key()))).toEqual([
      "amount",
      "deadline",
      "released",
      "released_amount",
    ]);
  });

  it("round-trips milestones with the contract's field names and types", () => {
    const decoded = scValToNative(
      milestonesToScVal([
        { amount: 300n, deadline: 0n },
        { amount: 700n, deadline: 1_700_000_000n },
      ]),
    );

    expect(decoded).toEqual([
      { amount: 300n, released: false, released_amount: 0n, deadline: 0n },
      {
        amount: 700n,
        released: false,
        released_amount: 0n,
        deadline: 1_700_000_000n,
      },
    ]);
  });

  it("encodes an empty list as an empty vector", () => {
    expect(scValToNative(milestonesToScVal([]))).toEqual([]);
  });
});

describe("buildCreateArgs", () => {
  it("builds [client, freelancer, token, milestones, expiry] with correct types", () => {
    const client = Keypair.random().publicKey();
    const freelancer = Keypair.random().publicKey();
    const token = Keypair.random().publicKey();

    const args = buildCreateArgs({
      client,
      freelancer,
      token,
      milestones: [{ amount: 1_000n, deadline: 0n }],
      expiry: 1_700_000_000n,
    });

    expect(args).toHaveLength(5);
    expect(scValToNative(args[0])).toBe(client);
    expect(scValToNative(args[1])).toBe(freelancer);
    expect(scValToNative(args[2])).toBe(token);
    expect(scValToNative(args[3])).toEqual([
      { amount: 1_000n, released: false, released_amount: 0n, deadline: 0n },
    ]);
    expect(scValToNative(args[4])).toBe(1_700_000_000n);
  });
});

describe("buildUpdateMilestonesArgs", () => {
  it("builds [escrow_id, milestones] with the contract's types", () => {
    const args = buildUpdateMilestonesArgs({
      escrowId: 7n,
      milestones: [
        { amount: 300n, deadline: 0n },
        { amount: 700n, deadline: 1_700_000_000n },
      ],
    });

    expect(args).toHaveLength(2);
    expect(scValToNative(args[0])).toBe(7n);
    expect(scValToNative(args[1])).toEqual([
      { amount: 300n, released: false, released_amount: 0n, deadline: 0n },
      { amount: 700n, released: false, released_amount: 0n, deadline: 1_700_000_000n },
    ]);
  });

  it("encodes milestones exactly like create does for the same list", () => {
    // `update_milestones` replaces the whole breakdown, so the two entry points
    // must not drift apart on field names, order or types.
    const milestones = [{ amount: 1_000n, deadline: 42n }];
    const [, updateEncoded] = buildUpdateMilestonesArgs({ escrowId: 1n, milestones });

    expect(updateEncoded.toXDR("base64")).toBe(
      buildCreateArgs({
        client: Keypair.random().publicKey(),
        freelancer: Keypair.random().publicKey(),
        token: Keypair.random().publicKey(),
        milestones,
        expiry: 1_700_000_000n,
      })[3].toXDR("base64"),
    );
  });
});
