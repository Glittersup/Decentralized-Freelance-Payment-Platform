/**
 * stellar.ts
 *
 * Thin wrapper around @stellar/stellar-sdk for use throughout the app.
 * All contract addresses and network config live here so contributors
 * only need to change one file when deploying to a new network.
 *
 * The Soroban transaction pipeline is:
 *   build → simulateTransaction → assembleTransaction → sign (Freighter)
 *   → sendTransaction → poll getTransaction
 *
 * Contributor Notes:
 * - VITE_ env vars are injected at build time via Vite.
 * - For testnet development copy .env.example → .env and fill in deployed
 *   addresses (scripts/deploy_testnet.sh writes this file for you).
 * - Never commit real secret keys; Freighter handles signing in the browser.
 * - Reads must work with no wallet: `readContract` simulates from the read-only
 *   source below and never touches the visitor's account (see READONLY_SOURCE).
 */

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { fromBaseUnits, toBaseUnits } from "./assets";
import { ContractReadError, asReadError, classifyReadFailure, friendlyError } from "./errors";

// ---------------------------------------------------------------------------
// Network config
// ---------------------------------------------------------------------------

export type NetworkName = "testnet" | "mainnet";

const NETWORK_CONFIG = {
  testnet: {
    networkPassphrase: Networks.TESTNET,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
  },
  mainnet: {
    networkPassphrase: Networks.PUBLIC,
    rpcUrl: "https://soroban-mainnet.stellar.org",
    horizonUrl: "https://horizon.stellar.org",
  },
} as const;

export const ACTIVE_NETWORK: NetworkName =
  (import.meta.env.VITE_NETWORK as NetworkName) ?? "testnet";

export const { networkPassphrase, rpcUrl, horizonUrl } =
  NETWORK_CONFIG[ACTIVE_NETWORK];

/** stellar.expert uses `public` (not `mainnet`) in its explorer paths. */
const EXPLORER_HOST: Record<NetworkName, string> = {
  testnet: "https://stellar.expert/explorer/testnet",
  mainnet: "https://stellar.expert/explorer/public",
};

/** Link to a transaction on stellar.expert for the active network. */
export const explorerTxUrl = (hash: string): string =>
  `${EXPLORER_HOST[ACTIVE_NETWORK]}/tx/${hash}`;

// ---------------------------------------------------------------------------
// Deployed contract addresses (set via .env)
// ---------------------------------------------------------------------------

export const CONTRACT_ADDRESSES = {
  escrow: import.meta.env.VITE_ESCROW_CONTRACT_ID ?? "",
  dispute: import.meta.env.VITE_DISPUTE_CONTRACT_ID ?? "",
  reputation: import.meta.env.VITE_REPUTATION_CONTRACT_ID ?? "",
  /** USDC issued by Circle on Stellar */
  usdc: import.meta.env.VITE_USDC_CONTRACT_ID ?? "",
} as const;

export const server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });

// ---------------------------------------------------------------------------
// Read-only simulation source
// ---------------------------------------------------------------------------

/**
 * All-zero ed25519 public key. It has no secret key and no ledger entry, and it
 * is only ever used as a simulation source, so it cannot move funds.
 */
const SIMULATION_ONLY_SOURCE =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/**
 * Public key used as the source account for read-only simulations.
 *
 * A Soroban view is executed as a *simulated* transaction, and the SDK needs an
 * `Account` (public key + sequence number) to build one. The source never signs
 * and is never charged, so for simulation it does not need to exist on-chain —
 * the RPC runs the contract call and returns its result. Using an all-zero,
 * secret-less key therefore lets a shared `/jobs/:id` or `/profile/:address`
 * link render in a fresh browser with no wallet, no extension and no funded
 * account; the sequence number is irrelevant to simulation and is never
 * submitted anywhere.
 *
 * Set `VITE_READONLY_SOURCE` to a funded public key if the RPC provider you use
 * rejects simulations whose source account is absent from the ledger. It is then
 * loaded with `getAccount` so the simulation uses its real sequence number.
 * Either way the account is only read from, never signed with.
 */
export const READONLY_SOURCE: string =
  import.meta.env.VITE_READONLY_SOURCE || SIMULATION_ONLY_SOURCE;

// ---------------------------------------------------------------------------
// ScVal helpers
// ---------------------------------------------------------------------------

export const scAddress = (address: string) => Address.fromString(address).toScVal();
export const scU64 = (n: bigint) => nativeToScVal(n, { type: "u64" });
export const scU32 = (n: number) => nativeToScVal(n, { type: "u32" });
export const scI128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
/**
 * Soroban `String`, as `dispute.raise`'s `reason` argument.
 *
 * The type is spelled out because it must not be inferred: `nativeToScVal("x")`
 * happens to pick String, but `Symbol` and `Bytes` are one keyword away and both
 * would be rejected by the contract with a type error at simulation time.
 */
export const scString = (value: string) => nativeToScVal(value, { type: "string" });

// ---------------------------------------------------------------------------
// Stroop conversion
//
// On-chain amounts are integer stroops at 7 decimal places. The arithmetic —
// including the exact rounding a float would otherwise lose — lives in
// `lib/assets.ts`; these are the stroop-named spelling of the same functions
// and delegate to it so the two copies cannot drift (see issue #45).
// ---------------------------------------------------------------------------

/** Stroops per whole unit, i.e. the 7 decimals every entry in `ASSETS` uses. */
const STROOP_DECIMALS = 7;

export const toStroops = (units: number) => toBaseUnits(units, STROOP_DECIMALS);
export const fromStroops = (stroops: bigint) => fromBaseUnits(stroops, STROOP_DECIMALS);

export interface MilestoneInput {
  amount: bigint;
  deadline: bigint;
}

/**
 * Encode a list of milestones as the `Vec<Milestone>` the contract expects.
 * Soroban structs are maps keyed by field-name symbols.
 *
 * Entries are emitted in **ascending key order** (`amount`, `deadline`,
 * `released`, `released_amount`): that is the order the Rust SDK produces for a
 * `#[contracttype]` struct and the order `nativeToScVal` sorts to, because the
 * Soroban runtime expects map keys in sorted order. Field-declaration order
 * round-trips fine in tests but can be rejected on-chain, after the fee is
 * spent — the backend's `lib/escrowArgs.ts` mirrors this shape exactly.
 */
export function milestonesToScVal(milestones: MilestoneInput[]): xdr.ScVal {
  const encoded = milestones.map((m) =>
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: scI128(m.amount) }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("deadline"),
        val: scU64(m.deadline),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("released"),
        val: xdr.ScVal.scvBool(false),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("released_amount"),
        val: scI128(0n),
      }),
    ]),
  );
  return xdr.ScVal.scvVec(encoded);
}

// ---------------------------------------------------------------------------
// Transaction pipeline
// ---------------------------------------------------------------------------

export interface BuiltTransaction {
  /** Assembled (footprint + resource fees applied) transaction XDR, ready to sign. */
  xdr: string;
  /** Return value of the call as a native JS value (from simulation). */
  result: unknown;
}

function simulationError(
  sim: SorobanRpc.Api.SimulateTransactionResponse,
): string | null {
  if (SorobanRpc.Api.isSimulationError(sim)) return sim.error;
  return null;
}

/** The source account a read-only call simulates from (never signs, never pays). */
async function readSourceAccount(): Promise<Account> {
  if (READONLY_SOURCE === SIMULATION_ONLY_SOURCE) return new Account(READONLY_SOURCE, "0");

  try {
    return await server.getAccount(READONLY_SOURCE);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new ContractReadError(
      "unavailable",
      `The configured read-only source account (${READONLY_SOURCE}) could not be loaded: ${detail}`,
    );
  }
}

/**
 * Build and simulate a contract call from `account`, returning the transaction
 * (for assembly) and the decoded return value.
 *
 * Every failure mode is normalized to `ContractReadError`, so callers can tell
 * "not found" from "unavailable" instead of re-parsing host strings.
 */
async function simulateContractCall(
  account: Account,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<{
  tx: ReturnType<TransactionBuilder["build"]>;
  sim: SorobanRpc.Api.SimulateTransactionSuccessResponse;
  result: unknown;
}> {
  if (!contractId) {
    throw new ContractReadError(
      "unavailable",
      "This contract address is not configured (.env)",
    );
  }

  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  let sim: SorobanRpc.Api.SimulateTransactionResponse;
  try {
    sim = await server.simulateTransaction(tx);
  } catch (e) {
    // Transport failure (offline, DNS, RPC 5xx): no answer was received.
    throw asReadError(e);
  }

  const err = simulationError(sim);
  if (err) throw new ContractReadError(classifyReadFailure(err), friendlyError(err));

  const success = sim as SorobanRpc.Api.SimulateTransactionSuccessResponse;
  const result = success.result?.retval ? scValToNative(success.result.retval) : undefined;
  return { tx, sim: success, result };
}

/**
 * Build a contract call for a **write**, simulate it to get the footprint +
 * fees, and return the assembled XDR plus the simulated return value.
 *
 * Writes are paid for by the user, so this loads their real account: an
 * unfunded account cannot submit, and the read-only source must never sign.
 * Public reads use `readContract` instead.
 */
export async function buildContractCall(
  sourcePublicKey: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<BuiltTransaction> {
  const account = await server.getAccount(sourcePublicKey);
  const { tx, sim, result } = await simulateContractCall(account, contractId, method, args);
  const assembled = SorobanRpc.assembleTransaction(tx, sim).build();

  return { xdr: assembled.toXDR(), result };
}

/**
 * Read-only call: simulate from the read-only source, decode the result. No
 * signing, no wallet, no account lookup — a shared link renders for a visitor.
 *
 * Rejects with `ContractReadError` (`kind` = not-found | unavailable | unknown).
 */
export async function readContract<T>(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<T> {
  const account = await readSourceAccount();
  const { result } = await simulateContractCall(account, contractId, method, args);
  return result as T;
}

/** Poll until the transaction is included in a ledger. */
export async function pollTransaction(
  hash: string,
  attempts = 15,
  delayMs = 1500,
): Promise<SorobanRpc.Api.GetTransactionResponse> {
  for (let i = 0; i < attempts; i++) {
    const res = await server.getTransaction(hash);
    if (res.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      return res;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`Transaction ${hash} not confirmed after ${attempts} attempts`);
}
