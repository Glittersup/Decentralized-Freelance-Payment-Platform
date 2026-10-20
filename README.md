# Stellar Freelance Payment Platform

A decentralized freelance payment platform built on Stellar. Enables secure, fast, transparent, and low-cost transactions between freelancers and clients — no intermediaries, no borders.

> **Testnet only.** The contracts are unaudited. Do not deploy them to mainnet or move real funds.

**Live:** frontend at <https://stellar-freelance-frontend.vercel.app> · contracts on Stellar testnet · backend API not deployed yet (see [Deployment](#deployment)).

---

## Contents

- [Live deployments](#live-deployments)
- [Why Stellar?](#why-stellar)
- [How it works](#how-it-works)
- [Project status](#project-status)
- [Architecture](#architecture)
- [Contract reference](#contract-reference)
- [Backend API](#backend-api)
- [Frontend](#frontend)
- [Stack](#stack)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Testing](#testing)
- [Deployment](#deployment)
- [Documentation](#documentation)
- [Security and limitations](#security-and-limitations)
- [Inspiration](#inspiration)
- [License](#license)

## Live deployments

| Piece | Where | Status |
|-------|-------|--------|
| Frontend | Vercel project `stellar-freelance-frontend` — <https://stellar-freelance-frontend.vercel.app> | ✅ Live, built with the contract ids below |
| Contracts | Stellar **testnet** (`Test SDF Network ; September 2015`) | ✅ Deployed and initialized |
| Backend API | Render (config committed, service not created yet) | ❌ Not deployed — job list needs `VITE_API_URL` |

The deployed frontend has all `VITE_*` contract variables set for Production and Preview, and deployment protection is off so the demo is reachable without a Vercel login. It is **not** connected to GitHub, so `git push` does not redeploy it:

```bash
cd frontend && vercel deploy --prod
```

## Why Stellar?

- **~5 second finality** — payments confirm faster than a bank transfer clears
- **~$0.00001 per transaction** — fees are negligible even for small milestone payments
- **USDC on Stellar** — stablecoin payments via Circle's SAC-wrapped USDC, eliminating crypto volatility for both parties
- **Soroban smart contracts** — Rust/Wasm contracts with a rich SDK and local testing environment

## How it works

1. **Client posts a job** — defines milestones (amount + deadline each) and funds the escrow contract.
2. **Freelancer delivers work** — the client releases each milestone, fully or in part, as deliverables are approved.
3. **Dispute resolution** — either party can freeze the escrow and raise a dispute; an M-of-N arbitrator panel distributes funds. If the panel stalls, a 7-day timelock unlocks an escape hatch — but only the client can use it.
4. **Reputation** — both parties rate each other on-chain after completion; scores are permanent, verifiable, and weighted by job size.

## Project status

Honest snapshot of what works today (see [`docs/TESTNET.md`](./docs/TESTNET.md) for live ids):

| Area | Status |
|------|--------|
| `escrow` contract | ✅ Complete — milestones (editable before funding, partial releases), expiry refunds, validated inputs, TTL, events |
| `dispute` contract | ✅ Complete — verified raise, M-of-N arbitrator panel, resolution that calls back into escrow, dispute timelock |
| `reputation` contract | ✅ Complete — escrow-verified 1–5 ratings, amount-weighted aggregates, per-pair anti-spam (`docs/REPUTATION.md`) |
| Contract tests | ✅ 86 tests: 83 unit tests (escrow 49, dispute 17, reputation 17) covering every state transition and failure path, plus 3 end-to-end tests in `contracts/dispute/tests/full_flow.rs` that drive escrow + dispute + reputation together |
| Backend tests | ✅ 138 tests |
| Frontend tests | ✅ 156 tests (Vitest + Testing Library) — pages, components and lib helpers |
| Testnet deployment | ✅ Deployed and initialized (ids in [`deployments/testnet.json`](./deployments/testnet.json)) |
| Frontend | 🟡 Functional MVP — connect Freighter, create/fund a job, release milestones, view status, open a dispute, rate the counterparty, read reputation, browse a profile's job history and ratings, export an escrow receipt |
| Backend API | ✅ Routes + auth implemented; contract-event indexer syncs DB state from Soroban RPC, with a dead-letter table for events it cannot apply |
| Job discovery / filtering | ✅ Dashboard lists jobs with status + skill-tag filters and pagination (from the backend API) |
| Multi-arbitrator / timelocked disputes | ✅ Panel with a timelock escape hatch from `Disputed` (see [`docs/DISPUTES.md`](./docs/DISPUTES.md)) |
| Dispute resolution authorization | ✅ `POST /api/disputes/:id/resolve` requires an `ARBITRATOR_ADDRESSES` entry, and fails closed when unset |
| Assets beyond USDC | ✅ Registry with USDC + XLM (`docs/ASSETS.md`); any SAC can be registered |
| Wallet auth | ✅ SEP-53 message signing verified server-side, with single-use nonces persisted in PostgreSQL |
| USDC configuration | ❌ Not wired on testnet yet — the demo uses the XLM SAC |
| Security audit | ❌ Not audited |

Scoped work is tracked in the [issue tracker](https://github.com/vatal-system/Decentralized-Freelance-Payment-Platform/issues); design notes for issues #2-#18 live in [`docs/wave-issues/`](./docs/wave-issues/).

## Architecture

Three Soroban contracts work together; the escrow contract holds the funds and is the only contract that can move them.

```
Client ── create / fund / release_milestone / release_partial / reclaim_* ──► EscrowContract
                                                                                 │  ▲
                                          arbitrate() ── resolve() ──┘  │ (dispute contract only)
DisputeContract ◄── Arbitrator                                        │
   raise(escrow_id, escrow_contract, raised_by, reason)               │
   (verifies escrow is Disputed; caller must be a party)              │
Client / Freelancer ── submit(rater, ratee, escrow_id, score) ──► ReputationContract
                      (verifies the job Completed + participants)
```

- **escrow** enforces the state machine `Created → Active → Completed`, with
  `Disputed → Completed` (via arbitration) and `Active → Refunded` (expiry).
- **dispute** can only change escrow funds through `escrow.resolve`, which
  independently checks that the shares sum to the funds held.
- **reputation** refuses any rating unless escrow reports the job `Completed`
  and the rater/ratee are the two participants.
- **backend** never holds funds or keys. It builds unsigned transactions for the
  frontend to sign, and mirrors on-chain state into PostgreSQL by indexing events.

The shared `interface` crate holds the types both contracts and clients agree on
(`Milestone`, `EscrowData`, `EscrowError`), so encodings cannot drift apart.
The events each contract emits are catalogued in [`docs/EVENTS.md`](./docs/EVENTS.md).
For the full design — each contract's responsibilities, the complete escrow
state machine, cross-contract calls, and the backend's role — see
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Contract reference

### `escrow`

| Function | Purpose |
|----------|---------|
| `init(admin, dispute_contract)` | One-shot setup; records the only contract allowed to call `resolve` |
| `set_dispute_contract(dispute_contract)` | Admin-only, for rotating the dispute contract |
| `create(client, freelancer, token, milestones, expiry)` | Creates an unfunded escrow and returns its id |
| `update_milestones(escrow_id, milestones)` | Client-only milestone editing, before funding |
| `fund(escrow_id)` | Moves the asset into escrow and activates the job |
| `release_milestone(escrow_id, milestone_index)` | Releases a whole milestone to the freelancer |
| `release_partial(escrow_id, milestone_index, amount)` | Releases part of a milestone; tracks `released_amount` |
| `open_dispute(escrow_id, initiator)` | Either participant freezes the escrow |
| `reclaim_after_dispute_timeout(escrow_id)` | Client-only escape hatch once the 7-day dispute timelock passes |
| `resolve(escrow_id, client_share, freelancer_share)` | Dispute-contract-only; splits the funds |
| `reclaim_expired(escrow_id)` | Client-only refund of the unreleased remainder after expiry; earlier partial releases are not clawed back |
| `get(escrow_id)` / `dispute_deadline(escrow_id)` / `dispute_contract()` | Read-only views |

### `dispute`

| Function | Purpose |
|----------|---------|
| `init(arbitrators, threshold)` | One-shot setup; validates a non-empty panel and `1 <= threshold <= len` |
| `raise(escrow_id, escrow_contract, raised_by, reason)` | Records the dispute and returns its id; cross-checks that the escrow is `Disputed` and `raised_by` is a party |
| `approve(dispute_id, arbitrator, client_share, freelancer_share)` | Panel-only vote on a split; rejects negative shares only — the sum must equal the funds held, enforced later by `escrow.resolve` |
| `arbitrate(dispute_id, client_share, freelancer_share)` | Executes the split once approvals *for that exact split* reach the threshold; cross-calls `escrow.resolve` |
| `get(dispute_id)` / `dispute_for(escrow_id)` / `arbitrators()` / `threshold()` | Read-only views |

### `reputation`

| Function | Purpose |
|----------|---------|
| `init(admin, escrow_contract)` | One-shot setup |
| `submit(rater, ratee, escrow_id, score)` | 1–5 rating for a `Completed` job, one per pair per job |
| `get_aggregate(address)` | Amount-weighted `{ total_score, weight, count }` |
| `get_rating(rater, escrow_id)` | A single rating |

These tables are a summary; **the code is canonical** — `contracts/*/src/lib.rs`
is the source of truth, and this table set and the one in
[`CONTRIBUTING.md`](./CONTRIBUTING.md) must both match it. If a table and the
code ever disagree, trust the code and fix the table: the PR checklist
(`.github/pull_request_template.md`) asks every PR to re-verify both copies.

Full signatures and error codes are in
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Backend API

Express + Prisma + PostgreSQL. Every `POST`/`PUT` below except `/api/users/auth`
requires `Authorization: Bearer <jwt>`; mutating routes that touch the chain
return an **unsigned XDR** for the client to sign, and never a key.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | — | Liveness probe (used by the container health check) |
| `GET` | `/api/users/challenge` | — | Issue a single-use nonce for SEP-53 signing |
| `POST` | `/api/users/auth` | — | Verify the signed message, return a JWT |
| `GET` | `/api/users/:address` | — | Public profile |
| `GET` | `/api/users/:address/transactions` | — | Indexed on-chain history for the address's escrows, with explorer links |
| `GET` | `/api/users/:address/reminders` | — | Milestone deadlines that are overdue or due soon (`?withinHours=`) |
| `PUT` | `/api/users/me` | ✅ | Update your own profile |
| `GET` | `/api/jobs` | — | List jobs with status + `tag` filters and pagination |
| `GET` | `/api/jobs/tags` | — | The curated skill-tag taxonomy |
| `GET` | `/api/jobs/saved` | ✅ | The caller's bookmarked jobs, newest first |
| `POST` | `/api/jobs/:id/save` | ✅ | Bookmark a job (idempotent) |
| `DELETE` | `/api/jobs/:id/save` | ✅ | Remove a bookmark |
| `POST` | `/api/jobs` | ✅ | Create the off-chain job record |
| `GET` | `/api/jobs/:id` | — | Job detail with milestones |
| `PUT` | `/api/jobs/:id/assign` | ✅ | Assign a freelancer |
| `POST` | `/api/escrow/build/create` | ✅ | Build `escrow.create` |
| `POST` | `/api/escrow/build/fund` | ✅ | Build `escrow.fund` |
| `POST` | `/api/escrow/build/release` | ✅ | Build `escrow.release_milestone` |
| `POST` | `/api/escrow/build/reclaim` | ✅ | Build `escrow.reclaim_expired` |
| `POST` | `/api/escrow/build/reclaim-dispute` | ✅ | Build `escrow.reclaim_after_dispute_timeout` (client, after the 7-day dispute timelock) |
| `POST` | `/api/escrow/build/update-milestones` | ✅ | Build `escrow.update_milestones` (client, before funding) |
| `PUT` | `/api/escrow/:escrowId/milestones` | ✅ | Record a confirmed milestone edit |
| `GET` | `/api/escrow/:escrowId/receipt` | — | Printable receipt: job, milestones, releases, transaction links |
| `POST` | `/api/escrow/sync/:jobId` | ✅ | Link an escrow id to a job |
| `POST` | `/api/disputes` | ✅ | Build `escrow.open_dispute` and record the dispute |
| `GET` | `/api/disputes/:id` | — | Dispute detail |
| `POST` | `/api/disputes/:id/resolve` | ✅ + arbitrator | Build `dispute.arbitrate` |
| `POST` | `/api/reputation` | ✅ | Build `reputation.submit` |
| `GET` | `/api/reputation/:address` | — | Aggregate reputation |
| `GET` | `/api/reputation/:address/ratings` | — | Individual ratings received (score, job, date) |

### Skills and categories

Jobs carry curated skill tags (issue #70). `backend/src/lib/tags.ts` holds the
canonical taxonomy — 16 slugs grouped across Development, Blockchain, Data,
Design, Content, Media and Business — and `createJobSchema` rejects anything
outside it, de-duplicates, and caps a job at 8 tags. `GET /api/jobs/tags`
serves the list, and `GET /api/jobs?tag=<slug>` filters with an indexed
containment query. The frontend keeps a mirror of the same list in
`frontend/src/lib/tags.ts` so the picker renders without a round-trip; the
backend copy is canonical, and `backend/src/__tests__/tags.test.ts` fails if the
two ever drift apart.

Rate limiting is 100 requests/minute per IP, and every request is logged as one
structured JSON line (method, path, status, duration) unless `NODE_ENV=test`.
The wallet-auth endpoints get a tighter, dedicated budget on top of that:
`GET /api/users/challenge` and `POST /api/users/auth` are each limited to
`AUTH_RATE_LIMIT_MAX` requests per IP per `AUTH_RATE_LIMIT_WINDOW_MS` (10 per
minute by default), with separate counters so one cannot lock out the other.
Exceeding it answers `429` with `{ "error": "Too many authentication attempts. Try again later." }`.
The **event indexer** runs in-process, polling Soroban RPC for the configured
contracts and applying events to the database. Failures are recorded in
`IndexerDeadLetter` rather than dropped, and the cursor is persisted so restarts
resume where they left off. `SIGTERM`/`SIGINT` stop the indexer, drain in-flight
requests, and disconnect Prisma before the process exits, so a deploy neither
cuts a response nor leaves the interval and connection dangling.

### OpenAPI spec

The routes are also described in OpenAPI 3.0, generated from the same Zod
schemas `validate()` enforces so the spec and the validation cannot drift.
Outside production the API serves the document and a Swagger UI explorer:

| Path | Purpose |
|------|---------|
| `GET /api/docs` | Swagger UI explorer |
| `GET /api/docs/openapi.json` | The raw OpenAPI 3.0 document |

Both are registered only when `NODE_ENV !== "production"`, so a deployed
instance exposes neither. Add a new route to `backend/src/openapi.ts`;
`backend/src/__tests__/openapi.test.ts` walks the routers and fails if one is
missing from the spec.

## Frontend

React + TypeScript + Vite, with Freighter for signing.

| Route | Page | Purpose |
|-------|------|---------|
| `/` | `Dashboard` | Filterable by status and skill tag, paginated job list, plus bookmarks and a saved-only view |
| `/post` | `PostJob` | Skill tags + milestones + asset picker → on-chain create/fund, then the off-chain record |
| `/activity` | `Activity` | Earnings at a glance: open escrows, completed jobs, and per-asset released/still-locked totals |
| `/jobs/:id` | `JobDetail` | Milestone state (incl. `released_amount`), release, dispute, rating, transaction links |
| `/profile/:address` | `Profile` | On-chain reputation aggregate (weighted average + rating count) |

Both of those are **public reads**: the escrow view and the reputation aggregate
are simulated from a read-only source account (`VITE_READONLY_SOURCE`, no wallet
required), so a shared link renders before Freighter is connected. Only writes —
create/fund, release, dispute, reclaim, rate — need a wallet. A read that fails
says whether the record does not exist or the network could not be reached,
rather than blaming the link.

A connected wallet can bookmark a job from the list and switch it to a
saved-only view (`frontend/src/hooks/useSavedJobs.ts`); bookmarks are personal
and off-chain, stored per user, and the toggle is idempotent on both sides.

`/activity` (issue #73) answers "how much has this address been paid, and how
much is still in escrow?" without opening each job: it reads `/api/jobs` twice
(`?client=` and `?freelancer=`), merges the two lists by id, and totals them with
`frontend/src/lib/activity.ts`. Totals are kept **per asset** — XLM and USDC are
never added together — and summed in integer base units (`bigint`), so a
total is exact rather than `0.30000000000000004`. "Released" deliberately spans
both roles (paid out as client, earned as freelancer), with the role counts
shown next to it, and the page states that its two reads are capped at the API's
100-job maximum per role.

`/activity` and every other screen that shows an amount also shows an
approximate fiat figure (`frontend/src/components/FiatEstimate.tsx`, issue
#76), sourced from CoinGecko's keyless `simple/price` feed and cached for five
minutes (`frontend/src/lib/prices.ts`). The figure is always labelled `est.`,
and when the feed is slow, rate-limited or down, nothing is shown at all — an
estimate never blocks or alters the amount it sits beside. `VITE_PRICE_API_URL`
and `VITE_PRICE_API_KEY` are optional overrides; the default needs no
configuration.

Every write shows the transaction hash and a stellar.expert link, contract errors
are mapped to readable messages (`frontend/src/lib/errors.ts`), and per-target
pending state stops double submits. Every address on screen is copyable in one
click and can be expanded into a QR code to scan into a wallet
(`frontend/src/components/AddressField.tsx`) — a `G…` address is 56 characters,
and selecting one by hand is how funds reach the wrong account. A top-level error
boundary wraps the routes, so a render error in one page shows a short fallback
with a reload control rather than blanking the app.

Every write also reports its lifecycle as a toast (`building → awaiting
signature → confirmed / failed`) that links the confirmed transaction on
stellar.expert and shows the mapped contract-error message on failure
(`frontend/src/components/Toaster.tsx`) — feedback that survives navigation,
unlike the inline messages alone. The job page carries the client↔freelancer
conversation (`frontend/src/components/Conversation.tsx`); opening a thread
records the read receipt, and unread counts appear next to each job and on the
nav. A milestone set can be saved as a template and re-applied from the
post-a-job form (`frontend/src/lib/templates.ts`, stored per wallet in the
browser).

## Stack

| Layer | Choice |
|-------|--------|
| Smart contracts | Rust (edition 2021) + Soroban SDK **29.0.0**, compiled to Wasm for `wasm32v1-none` |
| Frontend | React 18 + TypeScript + Vite 5, React Router 6, Vitest + Testing Library |
| Wallet | Freighter browser extension (SEP-53 message signing) |
| Backend | Express 4 + Prisma 5 + PostgreSQL, Zod validation, JWT (`jose`), Helmet, rate limiting |
| Chain access | `@stellar/stellar-sdk` 12 (Soroban RPC + Horizon) |
| CI | GitHub Actions — contracts (fmt, clippy, test, wasm build), frontend, backend (typecheck, tests, and Prisma migrations applied against a Postgres service), dependency vulnerability scan (advisory; `npm audit` + `cargo audit`) |

## Repository layout

```
contracts/            Cargo workspace
  interface/          Shared types + error codes (Milestone, EscrowData, EscrowError)
  escrow/             Holds funds; create, fund, release, dispute, refund
  dispute/            Arbitrator panel; raise, approve, arbitrate
                      (tests/full_flow.rs drives all three contracts end to end)
  reputation/         Ratings and weighted aggregates
backend/              Express API, Prisma schema + migrations, event indexer
  src/lib/            Pure helpers (events, escrowArgs, assets, signature, authNonce, access, reminders, receipt)
  prisma/migrations/  Committed SQL migrations, applied on container start
frontend/             React app, Vitest config, vercel.json
deployments/          testnet.json — machine-readable record of the live contracts
scripts/              deploy_testnet.sh, demo_testnet.sh
docs/                 EVENTS, ASSETS, DISPUTES, REPUTATION, TESTNET, DEPLOYMENT, wave-issues/
render.yaml           Render Blueprint for the backend API
docker-compose.yml    One-command local stack (Postgres + API + frontend)
```

## Getting started

### One command (Docker)

```bash
docker compose up --build
```

| Service | URL |
|---------|-----|
| Frontend | <http://localhost:5173> |
| Backend | <http://localhost:3000> (`GET /health`) |
| PostgreSQL | `localhost:5432` |

Pass any `VITE_*` value through the environment to bake it into the frontend
image — compose forwards the whole set (`VITE_NETWORK`, `VITE_API_URL`,
`VITE_ESCROW_CONTRACT_ID`, `VITE_DISPUTE_CONTRACT_ID`,
`VITE_REPUTATION_CONTRACT_ID`, `VITE_USDC_CONTRACT_ID`, `VITE_XLM_CONTRACT_ID`,
`VITE_READONLY_SOURCE`) as build args, so a containerised build is not stuck on
`http://localhost:3000`:

```bash
VITE_API_URL=https://api.example.com \
VITE_ESCROW_CONTRACT_ID=C... \
VITE_XLM_CONTRACT_ID=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  docker compose up --build
```

These are the same variables as the [Frontend configuration](#frontend-frontendenv)
table below; Vite inlines them, so changing one means rebuilding the image.

### Manual

```bash
# Contracts
rustup target add wasm32v1-none
cd contracts && cargo test

# Backend (needs a running PostgreSQL)
cd backend && npm ci && npx prisma generate
cp .env.example .env          # then fill DATABASE_URL + JWT_SECRET (>= 32 chars)
npx prisma migrate deploy && npm run dev

# Frontend
cd frontend && npm ci
cp .env.example .env          # then fill the VITE_* contract ids
npm run dev
```

Deploy and exercise the contracts on testnet:

```bash
stellar keys generate deployer --network testnet --fund
scripts/deploy_testnet.sh         # builds, deploys, initializes, records ids
scripts/demo_testnet.sh           # create → fund → release → rate → aggregate
scripts/demo_dispute_testnet.sh   # open_dispute → raise → approve → arbitrate
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for conventions and the manual setup in full.

## Configuration

Vite **inlines** `VITE_*` variables at build time, so changing one needs a rebuild,
not just a restart.

### Frontend (`frontend/.env`)

| Variable | Required | Notes |
|----------|----------|-------|
| `VITE_NETWORK` | ✅ | `testnet` (or `mainnet`, which is unsupported) |
| `VITE_ESCROW_CONTRACT_ID` | ✅ | Deployed escrow contract |
| `VITE_DISPUTE_CONTRACT_ID` | ✅ | Deployed dispute contract |
| `VITE_REPUTATION_CONTRACT_ID` | ✅ | Deployed reputation contract |
| `VITE_API_URL` | for hosted deploys | Backend origin; defaults to `http://localhost:3000` |
| `VITE_READONLY_SOURCE` | only if your RPC requires it | Funded public key used to simulate public reads; unset uses a built-in secret-less key, so `/jobs/:id` and `/profile/:address` need no account. See [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) |
| `VITE_XLM_CONTRACT_ID` | to pay in XLM | Testnet XLM SAC: `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| `VITE_USDC_CONTRACT_ID` | to pay in USDC | Empty until a USDC SAC is configured on testnet |

### Backend (`backend/.env`)

| Variable | Required | Notes |
|----------|----------|-------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `JWT_SECRET` | ✅ | **At least 32 characters** — the config schema exits the process otherwise |
| `NODE_ENV` | ✅ | `development` \| `production` \| `test` |
| `STELLAR_NETWORK` | ✅ | `testnet` \| `mainnet` |
| `SOROBAN_RPC_URL` | ✅ | `https://soroban-testnet.stellar.org` |
| `ESCROW_CONTRACT_ID` | ✅ | Without it the indexer logs `No contract IDs configured` and does nothing |
| `DISPUTE_CONTRACT_ID` | ✅ | As above |
| `REPUTATION_CONTRACT_ID` | ✅ | As above |
| `XLM_CONTRACT_ID` | to pay in XLM | Testnet XLM SAC |
| `USDC_CONTRACT_ID` | to pay in USDC | Empty until USDC is configured |
| `ARBITRATOR_ADDRESSES` | for dispute resolution | Comma-separated panel addresses allowed to call `POST /api/disputes/:id/resolve`. **Empty disables the route** — it fails closed |
| `CORS_ORIGIN` | for production | Comma-separated browser origins allowed to call the API. Empty allows every origin and logs a warning in production |
| `INDEXER_POLL_INTERVAL_MS` | — | Defaults to `5000` |
| `AUTH_RATE_LIMIT_MAX` | — | Per-IP budget for each wallet-auth route (`/api/users/challenge`, `/api/users/auth`), counted separately. Defaults to `10` |
| `AUTH_RATE_LIMIT_WINDOW_MS` | — | Window for those budgets, in milliseconds. Defaults to `60000` |
| `TRUST_PROXY` | — | Reverse proxy hop count (e.g. `1` behind Render/Heroku/Nginx) so rate limiting keys on real client IP. Defaults to `0` |
| `PORT` | — | Defaults to `3000` |

## Testing

```bash
# Contracts — 86 tests (83 unit + 3 integration)
cd contracts
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test
stellar contract build          # requires stellar-cli v25.2.0+

# Backend — 74 tests
cd backend
npx prisma generate
npx tsc --noEmit
npm test

# Frontend — 86 tests
cd frontend
npm run lint
npx tsc --noEmit
npm test
npm run build
```

CI runs all three on every push and pull request to `main` and
`integration/staging`, and applies the backend's Prisma migrations against a
Postgres service so a broken or drifted migration fails the build
([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)).

## Deployment

Contract ids change on every deploy. `scripts/deploy_testnet.sh` regenerates
`frontend/.env` and `backend/.env.contracts` automatically (backing up the
previous frontend file) and prints the values the Render dashboard needs, so no
consumer keeps pointing at superseded contracts. The deployed backend also warns
at startup when its configured ids no longer match `deployments/testnet.json`
(issue #91), and `render.yaml` deliberately carries no contract ids.

| Piece | Host | Why there |
|-------|------|-----------|
| Contracts | Stellar testnet | Only supported network; unaudited |
| Frontend | Vercel (or any static host) | Static Vite build; `frontend/vercel.json` carries the SPA rewrite React Router needs |
| Backend | Render, via [`render.yaml`](./render.yaml) | Needs a long-running process: the indexer polls Soroban RPC in-process, so serverless is not an option |

`backend/Dockerfile` applies migrations on start. CORS must be set to the
frontend origin, and `ARBITRATOR_ADDRESSES` must list the dispute panel.

Two operational notes for the free tiers: the Render service spins down when
idle, which pauses the indexer until it wakes and catches up from its persisted
cursor, and the prepared `render.yaml` leaves `DATABASE_URL` for you to set
because it creates no database.

Full checklist, environment tables, and post-deploy verification queries:
[`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).

## Documentation

| Document | Contents |
|----------|----------|
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Contracts, escrow state machine, interactions, and the backend's role |
| [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) | End-to-end deploy checklist and what is live today |
| [`docs/TESTNET.md`](./docs/TESTNET.md) | Live contract ids, explorer links, reproduction steps |
| [`docs/EVENTS.md`](./docs/EVENTS.md) | Event catalogue for indexers and clients |
| [`docs/ASSETS.md`](./docs/ASSETS.md) | Payment-asset registry and how to add one |
| [`docs/DISPUTES.md`](./docs/DISPUTES.md) | Arbitrator panel, thresholds, and the dispute timelock |
| [`docs/REPUTATION.md`](./docs/REPUTATION.md) | Rating rules, weighting, and anti-spam |
| [`docs/wave-issues/`](./docs/wave-issues/) | Design notes for issues #2-#18 (all implemented) |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Setup, conventions, contract reference tables |
| [`SECURITY.md`](./SECURITY.md) | How to report a vulnerability |
| [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) | Community expectations |

## Security and limitations

- **Unaudited and testnet-only.** The escrow, dispute, and reputation contracts
  have not been reviewed by a third party. Never move real funds.
- **The backend holds no keys and cannot move funds.** It returns unsigned XDR
  for the client to sign, and mirrors chain state into PostgreSQL.
- **The indexer trusts Soroban RPC.** Events it cannot apply land in
  `IndexerDeadLetter` instead of being dropped, because its cursor advances
  regardless — check that table after a deploy that changes event payloads.
- **Soroban RPC retains a rolling window (~7 days).** A fresh indexer starts just
  behind the chain tip rather than at genesis; a cursor older than the window is
  clamped, and the events in between are unrecoverable.
- **USDC is not wired on testnet yet** — the demo pays with the XLM SAC.
- **Rating strength is not identity-aware.** Amount-weighting and per-pair
  anti-spam raise the cost of farming, but a determined actor with many funded
  pairs can still inflate an aggregate.

## Inspiration

This project draws on patterns proven by:

- **Braintrust** (Ethereum/Polygon) — user-owned talent network, 0% freelancer fees
- **Canwork.io** (BNB Chain) — 1% fee, smart-contract escrow
- **.escrow** (Polkadot) — USDT-based escrow with configurable timelocks

Stellar's fee structure and finality speed make it a better fit for the global freelance market than any of these predecessors.

## License

MIT — see [`LICENSE`](./LICENSE). Copyright © 2026 Vatal System.
