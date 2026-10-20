import { describe, expect, it } from "vitest";
import { scValToNative } from "@stellar/stellar-sdk";
import { fromBaseUnits, toBaseUnits } from "./assets";
import { fromStroops, milestonesToScVal, toStroops, type MilestoneInput } from "./stellar";

describe("milestonesToScVal", () => {
  it("encodes the known input to the exact XDR the contract expects", () => {
    // Pinned byte-for-byte, and identical to the backend's `escrowArgs`
    // golden: `useEscrow.createAndFund` builds its own `escrow.create` call
    // from this helper, so a key that is reordered or no longer a Symbol
    // round-trips fine here and is rejected on-chain, after the fee is spent.
    const KNOWN_MILESTONES_XDR =
      "AAAAEAAAAAEAAAACAAAAEQAAAAEAAAAEAAAADwAAAAZhbW91bnQAAAAAAAoAAAAAAA" +
      "AAAAAAAAAAAAEsAAAADwAAAAhkZWFkbGluZQAAAAUAAAAAAAAAAAAAAA8AAAAIcmVs" +
      "ZWFzZWQAAAAAAAAAAAAAAA8AAAAPcmVsZWFzZWRfYW1vdW50AAAAAAoAAAAAAAAAAA" +
      "AAAAAAAAAAAAAAEQAAAAEAAAAEAAAADwAAAAZhbW91bnQAAAAAAAoAAAAAAAAAAAAA" +
      "AAAAAAK8AAAADwAAAAhkZWFkbGluZQAAAAUAAAAAZVPxAAAAAA8AAAAIcmVsZWFzZW" +
      "QAAAAAAAAAAAAAAA8AAAAPcmVsZWFzZWRfYW1vdW50AAAAAAoAAAAAAAAAAAAAAAAA" +
      "AAAA";

    const input: MilestoneInput[] = [
      { amount: 300n, deadline: 0n },
      { amount: 700n, deadline: 1_700_000_000n },
    ];

    expect(milestonesToScVal(input).toXDR("base64")).toBe(KNOWN_MILESTONES_XDR);
  });

  it("round-trips milestones with the contract's field names", () => {
    const input: MilestoneInput[] = [
      { amount: 300n, deadline: 0n },
      { amount: 700n, deadline: 1_700_000_000n },
    ];

    const decoded = scValToNative(milestonesToScVal(input)) as Array<
      Record<string, unknown>
    >;

    expect(decoded).toHaveLength(2);
    expect(Object.keys(decoded[0]).sort()).toEqual([
      "amount",
      "deadline",
      "released",
      "released_amount",
    ]);
    expect(decoded[0]).toEqual({
      amount: 300n,
      released: false,
      released_amount: 0n,
      deadline: 0n,
    });
    expect(decoded[1]).toEqual({
      amount: 700n,
      released: false,
      released_amount: 0n,
      deadline: 1_700_000_000n,
    });
  });

  it("encodes an empty list as an empty vector", () => {
    expect(scValToNative(milestonesToScVal([]))).toEqual([]);
  });
});

describe("stroop conversion", () => {
  // Issue #45: `toStroops`/`fromStroops` used to reimplement the fixed 1e7
  // case. They now delegate to the single implementation in `lib/assets.ts`,
  // and these assertions pin that they stay identical to it.
  it("matches the shared base-unit helpers across a range of values", () => {
    for (const units of [0, 1, 1.5, 0.1, 0.3, 123.456789, 2]) {
      expect(toStroops(units)).toBe(toBaseUnits(units, 7));
    }
    for (const stroops of [0n, 1n, 15_000_000n, 3_000_000n]) {
      expect(fromStroops(stroops)).toBe(fromBaseUnits(stroops, 7));
    }
  });

  it("converts exactly, without a multiply-then-round that a float could skew", () => {
    expect(toStroops(1.5)).toBe(15_000_000n);
    expect(toStroops(0.1)).toBe(1_000_000n);
    expect(fromStroops(15_000_000n)).toBeCloseTo(1.5);
    expect(fromStroops(toStroops(0.1))).toBeCloseTo(0.1);
  });
});
