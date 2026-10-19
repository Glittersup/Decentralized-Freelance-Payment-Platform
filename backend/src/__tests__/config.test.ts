import { describe, expect, it } from "vitest";

describe("backend config (issue #39)", () => {
  it("allows HORIZON_URL to be omitted", async () => {
    const { config } = await import("../config");
    // With HORIZON_URL dropped from vitest.config.ts env, config successfully loads
    expect(config).toBeDefined();
    expect(config.SOROBAN_RPC_URL).toBeDefined();
    expect(config.HORIZON_URL).toBeUndefined();
  });
});
