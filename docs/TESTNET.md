# Testnet deployment

The three contracts are deployed to Stellar **testnet** and initialized. These
are testnet-only deployments; never send real funds to them.

| Contract | Contract ID | Explorer |
|----------|-------------|----------|
| escrow | `CALNRFGMUI7MLNLWO445U2BSDENF6DENURHXXFFRT6PV5GSOQX7GZGP7` | https://lab.stellar.org/r/testnet/contract/CALNRFGMUI7MLNLWO445U2BSDENF6DENURHXXFFRT6PV5GSOQX7GZGP7 |
| dispute | `CB24TF5GPP7EA6VWK4KZWBHHSY6FWNV3DKOGSZSDK347EODGGNPN7IMF` | https://lab.stellar.org/r/testnet/contract/CB24TF5GPP7EA6VWK4KZWBHHSY6FWNV3DKOGSZSDK347EODGGNPN7IMF |
| reputation | `CA5GXR4LVH5DYGB2RZDFAM3VNJW6LQ5EKUKURSLZBJGAH7LFJAOHKSET` | https://lab.stellar.org/r/testnet/contract/CA5GXR4LVH5DYGB2RZDFAM3VNJW6LQ5EKUKURSLZBJGAH7LFJAOHKSET |

- **Network:** testnet (`Test SDF Network ; September 2015`)
- **Admin / arbitrator:** `GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B`
  (the panel is `init(admin=admin, arbitrators=[admin], threshold=1)`)
- **USDC contract:** *not configured* — the demo uses the testnet XLM SAC
  (`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`) so it can run
  without Circle testnet USDC. Set `USDC_CONTRACT_ID` before deploying to use a
  real USDC SAC.

> These ids are from the most recent deploy and are replaced whenever the
> contracts change. `scripts/deploy_testnet.sh` rewrites `deployments/testnet.json`,
> `frontend/.env` and `backend/.env.contracts`, and prints the values for the
> deployed backend, so re-run it instead of hand-editing any of them. The API
> warns at startup when its configured ids no longer match the record (issue #91).
- The machine-readable record lives in [`../deployments/testnet.json`](../deployments/testnet.json).

## Reproduce the deployment

Prerequisites: `stellar-cli` v25.2.0+ (v28 current) and Rust stable with the
`wasm32v1-none` target.

```bash
rustup target add wasm32v1-none
stellar keys generate deployer --network testnet --fund

# Builds, deploys, initializes all three contracts, and writes
# deployments/testnet.json + frontend/.env + backend/.env.contracts
scripts/deploy_testnet.sh
```

## Reproduce the end-to-end flow

```bash
scripts/demo_testnet.sh
```

The demo runs `create → fund → release all milestones → status Completed →
submit rating → get_aggregate`, printing the transaction results. It uses the
testnet XLM SAC by default; pass `TOKEN_CONTRACT_ID=<sac>` to use another asset.

The dispute path (`open_dispute → raise → approve → arbitrate`) has its own
demo, which asserts the escrow ends `Completed` and the dispute `Resolved`:

```bash
scripts/demo_dispute_testnet.sh
```

## A note on builds (Soroban SDK v28+)

Soroban SDK v28+ requires:
- the **`wasm32v1-none`** target (not `wasm32-unknown-unknown`), and
- building via **`stellar contract build`** (the SDK build script refuses a
  plain `cargo build` for the wasm target).

Wasm artifacts land in `contracts/target/wasm32v1-none/release/`.
