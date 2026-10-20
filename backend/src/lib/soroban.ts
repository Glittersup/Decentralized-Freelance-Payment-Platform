/**
 * soroban.ts
 *
 * The one Soroban RPC client and the one transaction builder the API uses.
 *
 * Every route that hands the client an unsigned transaction does the same four
 * things: fetch the source account, build a single-operation transaction,
 * simulate it so the footprint and fees are correct, and assemble the result
 * into XDR. That sequence used to be copied into `routes/escrow.ts`,
 * `routes/disputes.ts` and twice into `routes/reputation.ts` (issue #36). A fix
 * to one copy — a different timeout, a new fee strategy, a missing simulation
 * check — would not reach the others, and a contract error could surface as a
 * raw `HostError` from whichever copy had not learned to translate it.
 *
 * Keeping it here also means one `server` instance, so a change to the RPC URL
 * or a future transport tweak applies everywhere at once.
 */

import {
  BASE_FEE,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { config } from "../config";
import { friendlyContractError } from "./contractErrors";
import { AppError } from "../middleware/errorHandler";

/** The single RPC client for the configured Soroban network. */
export const sorobanServer = new SorobanRpc.Server(config.SOROBAN_RPC_URL);

/** The passphrase the transaction must be signed against. */
export const networkPassphrase =
  config.STELLAR_NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

export interface BuildTxOptions {
  /**
   * The error table of the contract being called (`ESCROW_ERROR_MESSAGES`,
   * `DISPUTE_ERROR_MESSAGES`, `REPUTATION_ERROR_MESSAGES`). A contract rejection
   * is a caller mistake — wrong state, not a party — so it is answered as a
   * named 400 rather than a raw host string. Omit it for a contract whose
   * errors have no table yet; the generic translation still applies.
   */
  messages?: Record<number, string>;
  /**
   * Optional prefix for the 400 message. `reputation.ts` historically prefixed
   * its simulation failures with "Simulation failed: "; keeping the option
   * preserves that response text while the implementation is shared.
   */
  errorPrefix?: string;
}

/**
 * Build and simulate a single-operation Soroban transaction, returning the
 * assembled XDR for the wallet to sign.
 *
 * A simulation error is thrown as an `AppError(400)`, so the error handler
 * returns a client-facing message and the route never persists state for a
 * transaction that could not succeed.
 */
export async function buildTx(
  sourceAddress: string,
  operation: xdr.Operation,
  options: BuildTxOptions = {},
): Promise<string> {
  const account = await sorobanServer.getAccount(sourceAddress);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const simulation = await sorobanServer.simulateTransaction(tx);
  if ("error" in simulation) {
    const friendly = friendlyContractError(simulation.error, options.messages);
    throw new AppError(
      400,
      options.errorPrefix ? `${options.errorPrefix}: ${friendly}` : friendly,
    );
  }

  return SorobanRpc.assembleTransaction(tx, simulation).build().toXDR();
}
