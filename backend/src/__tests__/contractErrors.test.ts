import { describe, it, expect } from "vitest";
import {
  DISPUTE_ERROR_MESSAGES,
  ESCROW_ERROR_MESSAGES,
  REPUTATION_ERROR_MESSAGES,
  friendlyContractError,
  parseContractErrorCode,
} from "../lib/contractErrors";

describe("parseContractErrorCode", () => {
  it("extracts the discriminant from a Soroban host error", () => {
    expect(parseContractErrorCode("HostError: Error(Contract, #2)")).toBe(2);
    expect(parseContractErrorCode("Error(Contract, #16)")).toBe(16);
    // The spacing an RPC response may use.
    expect(parseContractErrorCode("Error(Contract,  #5)")).toBe(5);
  });

  it("returns null for anything that is not a contract error", () => {
    expect(parseContractErrorCode("Simulation failed: network timeout")).toBeNull();
    expect(parseContractErrorCode("")).toBeNull();
  });
});

describe("friendlyContractError", () => {
  it("names the escrow error the contract returned", () => {
    // InvalidStatus is the one the milestone-edit route relies on: the chain is
    // the authority on whether an escrow can still be edited.
    expect(friendlyContractError("HostError: Error(Contract, #2)")).toBe(
      ESCROW_ERROR_MESSAGES[2],
    );
    expect(friendlyContractError("HostError: Error(Contract, #1)")).toMatch(/escrow/i);
  });

  it("keeps the original text for a failure it cannot map", () => {
    const host = "Simulation failed: Connection refused";
    expect(friendlyContractError(host)).toBe(host);
    // A code outside the escrow enum is left alone rather than mislabeled.
    const unknown = "HostError: Error(Contract, #99)";
    expect(friendlyContractError(unknown)).toBe(unknown);
  });

  it("covers every EscrowError discriminant", () => {
    // contracts/interface/src/lib.rs declares 1..=18 (18 = InvalidDisputeTimeout);
    // a gap would leave an avoidable raw host error in a 400 body.
    for (let code = 1; code <= 18; code++) {
      expect(ESCROW_ERROR_MESSAGES[code]).toBeTruthy();
      expect(parseContractErrorCode(`Error(Contract, #${code})`)).toBe(code);
    }
  });

  it("covers every DisputeError discriminant", () => {
    // contracts/dispute/src/lib.rs declares 1..=14.
    for (let code = 1; code <= 14; code++) {
      expect(DISPUTE_ERROR_MESSAGES[code]).toBeTruthy();
    }
  });

  it("covers every ReputationError discriminant", () => {
    // contracts/reputation/src/lib.rs declares 1..=10.
    for (let code = 1; code <= 10; code++) {
      expect(REPUTATION_ERROR_MESSAGES[code]).toBeTruthy();
    }
  });

  it("uses the dispute map for a dispute call, since the codes collide", () => {
    // #7 is ZeroAmount in EscrowError and EscrowNotDisputed in DisputeError: the
    // same number, two different explanations. A route must pass its own map or
    // it reports "amounts must be greater than zero" for a non-disputed escrow.
    const host = "HostError: Error(Contract, #7)";

    expect(friendlyContractError(host)).toBe(ESCROW_ERROR_MESSAGES[7]);
    expect(friendlyContractError(host, DISPUTE_ERROR_MESSAGES)).toMatch(/isn't disputed/i);
  });

  it("translates AlreadyRated (#5) via the reputation map", () => {
    const host = "HostError: Error(Contract, #5)";
    expect(friendlyContractError(host, REPUTATION_ERROR_MESSAGES)).toMatch(/already rated/i);
    // Default map maps #5 to something different (MilestoneIndexOutOfBounds).
    expect(friendlyContractError(host)).not.toMatch(/already rated/i);
  });
});
