#!/usr/bin/env bash
#
# Deploy the three Soroban contracts to Stellar testnet and initialize them.
#
# Usage:
#   scripts/deploy_testnet.sh
#
# Environment variables (all optional):
#   NETWORK   – stellar network name (default: testnet)
#   IDENTITY  – stellar-cli identity/secret name (default: deployer)
#   USDC_CONTRACT_ID
#             – Stellar Asset Contract id for USDC on the target network.
#               If unset, deployment still runs but the frontend .env will not
#               get a USDC address. See docs/TESTNET.md for how to obtain it.
#   XLM_CONTRACT_ID
#             – Stellar Asset Contract id for native XLM on the target network.
#               On testnet this is
#               CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC.
#               If unset, the frontend falls back to its built-in default.
#   VITE_API_URL
#             – base URL of the backend REST API baked into frontend/.env.
#               Leave unset for local development (defaults to localhost:3000);
#               set it to the deployed backend origin before building for a
#               hosted frontend.
#   READONLY_SOURCE
#             – public key of a funded account used as the simulation source for
#               the frontend's public reads (/jobs/:id, /profile/:address).
#               Optional: reads normally simulate from a built-in, secret-less
#               key and need no account at all, so leave this unset unless your
#               RPC provider rejects simulations from a source that is not on
#               the ledger. The account is only read from, never signed with, so
#               the public key is enough.
#   KEEP_FRONTEND_ENV
#             – set to 1 to keep an existing frontend/.env untouched. By default
#               the file is regenerated (a previous one is backed up to
#               frontend/.env.bak), because contract ids from an earlier deploy
#               are stale the moment the contracts are redeployed.
#
# Outputs:
#   deployments/testnet.json   machine-readable record of the new contracts
#   frontend/.env              VITE_* ids baked into the next Vite build
#   backend/.env.contracts     ESCROW_/DISPUTE_/REPUTATION_ ids for the API
#   (stdout)                   checklist of the dashboard values to update
#
# Requirements:
#   - stellar-cli v25.2.0+  (v28 is current)
#   - a funded testnet identity:  stellar keys generate deployer --network testnet --fund
#
# This script never handles real funds and only targets testnet by default.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$REPO_ROOT/contracts"
WASM_DIR="$CONTRACTS_DIR/target/wasm32v1-none/release"
DEPLOYMENTS_DIR="$REPO_ROOT/deployments"

NETWORK="${NETWORK:-testnet}"
IDENTITY="${IDENTITY:-deployer}"
USDC_CONTRACT_ID="${USDC_CONTRACT_ID:-}"
XLM_CONTRACT_ID="${XLM_CONTRACT_ID:-}"
VITE_API_URL="${VITE_API_URL:-}"
READONLY_SOURCE="${READONLY_SOURCE:-}"
KEEP_FRONTEND_ENV="${KEEP_FRONTEND_ENV:-}"

command -v stellar >/dev/null || {
  echo "error: stellar-cli not found. Install v25.2.0+ from https://github.com/stellar/stellar-cli/releases" >&2
  exit 1
}

echo "==> Building contracts"
(cd "$CONTRACTS_DIR" && stellar contract build)

ADMIN="$(stellar keys address "$IDENTITY")"
echo "==> Deployer/admin address: $ADMIN"
echo "==> Network: $NETWORK"

# Extract the contract id (C...) from stellar-cli output.
deploy() {
  local wasm="$1"
  local out
  out="$(stellar contract deploy --wasm "$wasm" --source "$IDENTITY" --network "$NETWORK")"
  echo "$out" | grep -oE 'C[A-Z2-7]{55}' | tail -1
}

echo "==> Deploying escrow"
ESCROW_CONTRACT_ID="$(deploy "$WASM_DIR/escrow.wasm")"
echo "    escrow:     $ESCROW_CONTRACT_ID"

echo "==> Deploying dispute"
DISPUTE_CONTRACT_ID="$(deploy "$WASM_DIR/dispute.wasm")"
echo "    dispute:    $DISPUTE_CONTRACT_ID"

echo "==> Deploying reputation"
REPUTATION_CONTRACT_ID="$(deploy "$WASM_DIR/reputation.wasm")"
echo "    reputation: $REPUTATION_CONTRACT_ID"

invoke() {
  local id="$1"; shift
  stellar contract invoke --id "$id" --source "$IDENTITY" --network "$NETWORK" -- "$@"
}

echo "==> Initializing contracts"
# escrow is told which dispute contract is allowed to call resolve().
invoke "$ESCROW_CONTRACT_ID" init --admin "$ADMIN" --dispute_contract "$DISPUTE_CONTRACT_ID"
# dispute knows its arbitrator panel and M-of-N threshold.
invoke "$DISPUTE_CONTRACT_ID" init --admin "$ADMIN" --arbitrators "[\"$ADMIN\"]" --threshold 1
# reputation verifies completions against the escrow contract.
invoke "$REPUTATION_CONTRACT_ID" init --admin "$ADMIN" --escrow_contract "$ESCROW_CONTRACT_ID"

mkdir -p "$DEPLOYMENTS_DIR"
cat > "$DEPLOYMENTS_DIR/testnet.json" <<JSON
{
  "network": "$NETWORK",
  "admin": "$ADMIN",
  "escrow_contract_id": "$ESCROW_CONTRACT_ID",
  "dispute_contract_id": "$DISPUTE_CONTRACT_ID",
  "reputation_contract_id": "$REPUTATION_CONTRACT_ID",
  "usdc_contract_id": "$USDC_CONTRACT_ID",
  "xlm_contract_id": "$XLM_CONTRACT_ID"
}
JSON

echo "==> Wrote $DEPLOYMENTS_DIR/testnet.json"

# Contract ids change on every deploy, so a stale frontend/.env silently points
# the app at the previous contracts. Regenerate it (keeping a backup) unless the
# caller explicitly asked us to leave it alone.
FE_ENV="$REPO_ROOT/frontend/.env"
if [ -f "$FE_ENV" ] && [ "$KEEP_FRONTEND_ENV" = "1" ]; then
  echo "==> KEEP_FRONTEND_ENV=1, leaving $FE_ENV untouched"
else
  if [ -f "$FE_ENV" ]; then
    cp "$FE_ENV" "$FE_ENV.bak"
    echo "==> Backed up the previous $FE_ENV to $FE_ENV.bak"
  fi
  cat > "$FE_ENV" <<ENV
VITE_NETWORK=$NETWORK
VITE_API_URL=$VITE_API_URL
VITE_ESCROW_CONTRACT_ID=$ESCROW_CONTRACT_ID
VITE_DISPUTE_CONTRACT_ID=$DISPUTE_CONTRACT_ID
VITE_REPUTATION_CONTRACT_ID=$REPUTATION_CONTRACT_ID
VITE_USDC_CONTRACT_ID=$USDC_CONTRACT_ID
VITE_XLM_CONTRACT_ID=$XLM_CONTRACT_ID
VITE_READONLY_SOURCE=$READONLY_SOURCE
ENV
  echo "==> Wrote $FE_ENV"
fi

# The backend is a second consumer of the same ids. Emit a dotenv fragment it
# can load directly, and print the exact values the hosted dashboard needs —
# render.yaml deliberately no longer hardcodes them (issue #91), because a
# committed id is stale the moment the contracts are redeployed.
BE_ENV="$REPO_ROOT/backend/.env.contracts"
cat > "$BE_ENV" <<ENV
STELLAR_NETWORK=$NETWORK
ESCROW_CONTRACT_ID=$ESCROW_CONTRACT_ID
DISPUTE_CONTRACT_ID=$DISPUTE_CONTRACT_ID
REPUTATION_CONTRACT_ID=$REPUTATION_CONTRACT_ID
USDC_CONTRACT_ID=$USDC_CONTRACT_ID
XLM_CONTRACT_ID=$XLM_CONTRACT_ID
ARBITRATOR_ADDRESSES=$ADMIN
ENV
echo "==> Wrote $BE_ENV"

cat <<CHECKLIST

==> Redeploy checklist — every consumer of these ids must be updated:

    1. Backend env (Render dashboard → stellar-freelance-api → Environment).
       render.yaml no longer carries contract ids, so set these and redeploy:
         ESCROW_CONTRACT_ID=$ESCROW_CONTRACT_ID
         DISPUTE_CONTRACT_ID=$DISPUTE_CONTRACT_ID
         REPUTATION_CONTRACT_ID=$REPUTATION_CONTRACT_ID
         ARBITRATOR_ADDRESSES=$ADMIN

    2. Frontend (Vercel): frontend/.env above is baked in at build time.
       Set the same VITE_* vars and redeploy:  cd frontend && vercel deploy --prod

    3. Local / VPS backend: backend/.env.contracts above is ready to load.

    The API compares its configured ids with $DEPLOYMENTS_DIR/testnet.json at
    startup and logs "[config] Contract IDs do not match the latest deploy" when
    they diverge. After updating, restart the backend and confirm that line is
    gone. Full procedure: docs/DEPLOYMENT.md → "Redeploying the contracts".

CHECKLIST

echo "==> Done."
