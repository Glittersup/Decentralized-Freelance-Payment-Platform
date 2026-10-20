/**
 * `lib/soroban.ts` — the one transaction builder (issue #36).
 *
 * Before this module, `escrow.ts`, `disputes.ts` and `reputation.ts` each
 * declared their own `server`, `networkPassphrase` and near-identical `buildTx`,
 * with `reputation.ts` inlining a fourth copy. These tests pin both halves of
 * the fix:
 *
 *   1. the shared builder builds, simulates and assembles a transaction, and
 *      still turns a contract rejection into a named 400;
 *   2. the routers import it instead of declaring a private copy, so the
 *      duplication cannot come back silently.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Contract, Keypair } from "@stellar/stellar-sdk";

const CALLER = Keypair.random().publicKey();
const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

const h = vi.hoisted(() => ({
  simulate: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  class FakeServer {
    async getAccount(address: string) {
      return new actual.Account(address, "1");
    }

    async simulateTransaction(tx: unknown) {
      return h.simulate(tx);
    }
  }

  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: FakeServer,
      assembleTransaction: () => ({ build: () => ({ toXDR: () => "assembled-xdr" }) }),
    },
  };
});

describe("buildTx", () => {
  afterEach(() => {
    h.simulate.mockReset();
  });

  it("builds, simulates and assembles a single-operation transaction", async () => {
    h.simulate.mockResolvedValue({});
    const { buildTx } = await import("../lib/soroban");

    const xdr = await buildTx(CALLER, new Contract(CONTRACT_ID).call("submit"));

    expect(xdr).toBe("assembled-xdr");
    expect(h.simulate).toHaveBeenCalledOnce();
  });

  it("maps a contract rejection through the caller's error table", async () => {
    h.simulate.mockResolvedValue({ error: "HostError: Error(Contract, #5)" });
    const { buildTx } = await import("../lib/soroban");
    const { AppError } = await import("../middleware/errorHandler");
    const { REPUTATION_ERROR_MESSAGES } = await import("../lib/contractErrors");

    const err = await buildTx(
      CALLER,
      new Contract(CONTRACT_ID).call("submit"),
      { messages: REPUTATION_ERROR_MESSAGES, errorPrefix: "Simulation failed" },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as InstanceType<typeof AppError>).statusCode).toBe(400);
    expect((err as Error).message).toBe(
      "Simulation failed: You have already rated this job.",
    );
  });
});

/**
 * The structural half of #36: no router may declare its own RPC client or
 * transaction builder. Route tests would still pass if a copy came back, so
 * this reads the source the way `ciWorkflows.test.ts` reads the workflows.
 */
describe("routers use the shared builder", () => {
  const backendRoot = [process.cwd(), path.resolve(process.cwd(), "backend")].find((dir) =>
    existsSync(path.join(dir, "src", "routes")),
  );
  if (!backendRoot) throw new Error("backend/src/routes not found");

  for (const route of ["escrow", "disputes", "reputation"]) {
    it(`${route}.ts imports lib/soroban and declares no client of its own`, () => {
      const source = readFileSync(
        path.join(backendRoot, "src", "routes", `${route}.ts`),
        "utf8",
      );

      expect(source).toContain('from "../lib/soroban"');
      expect(source).not.toMatch(/new SorobanRpc\.Server/);
      expect(source).not.toMatch(/new TransactionBuilder/);
      expect(source).not.toMatch(/networkPassphrase\s*=/);
    });
  }
});
