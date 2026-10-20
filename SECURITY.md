# Security Policy

## Supported versions

The project is **pre-1.0 and unaudited**. Only the `main` branch is supported.

## Scope

The contracts are **testnet-only**. They have not been audited and must not be
deployed to mainnet or used to hold real funds. Reports about the following are
in scope:

- `contracts/escrow`, `contracts/dispute`, `contracts/reputation`,
  `contracts/interface`
- Authorization, fund-distribution, or state-machine flaws
- Storage/TTL issues that could strand funds or state
- The frontend transaction pipeline (`frontend/src/lib/stellar.ts`,
  `frontend/src/hooks`)
- The backend API (`backend/src`)

Out of scope:

- Issues that require mainnet deployment or real funds
- Third-party dependencies (please report upstream). This is a policy for
  reports, not a gap in coverage: CI runs `npm audit` / `cargo audit` on every
  push and PR, and bumps are landed manually — see *Dependency security* in
  [`CONTRIBUTING.md`](./CONTRIBUTING.md).
- Denial of service via expensive-but-authorized calls on testnet

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through GitHub's
[security advisories](https://github.com/vatal-system/Decentralized-Freelance-Payment-Platform/security/advisories/new)
or by contacting the maintainers directly.

Please include:

- A description of the issue and its impact
- Steps to reproduce (a failing test is ideal)
- Any suggested fix

We will acknowledge the report and work on a fix before public disclosure. Please
give us reasonable time before disclosing publicly.

## Known limitations (not vulnerabilities to report)

These are documented, intentional gaps tracked as issues. This section is
maintained against the code on `main` and distinguishes what the contracts
*implement* from what the deployed testnet deployment *configures*:

- **The arbitrator panel is trust-based, and testnet deploys it with one
  member.** `dispute.init(admin, arbitrators, threshold)` accepts an M-of-N panel,
  managed by the configured admin, and
  `dispute.arbitrate` executes a split only once `threshold` approvals for that
  exact split exist (`contracts/dispute/src/lib.rs`). What remains limited: the
  deployed testnet configuration is a single arbitrator with `threshold = 1`
  (`scripts/deploy_testnet.sh`), so a testnet ruling is still one key's
  decision; and there is no slashing or bonding, so a panel member who approves
  a bad split loses nothing.
- **A stalled dispute does not resolve itself.**
  `escrow.reclaim_after_dispute_timeout` is a timelocked escape hatch: after the
  configurable deadline set by `open_dispute` (`escrow.dispute_deadline` view), the
  client can reclaim unreleased funds, and a late ruling is then rejected
  because the escrow is no longer `Disputed`. What remains limited: nothing
  fires automatically at the deadline, and only the client may reclaim — the
  hatch protects the client against a stalling panel, not the freelancer.
- **The backend database is a best-effort mirror of the chain.**
  `backend/src/indexer.ts` polls Soroban RPC, persists its position in
  `IndexerCursor` so it resumes across restarts, and records failed events in
  `IndexerDeadLetter` instead of letting one bad event block the batch. What
  remains limited: the RPC retains only a rolling window of ledgers (~7 days),
  so an indexer outage longer than that window leaves a permanent, logged gap
  in the mirrored state, and dead letters are replayed by hand, not
  automatically. Treat the chain as the source of truth.
- **USDC is not yet configured on testnet** (the demo uses the XLM SAC;
  `usdc_contract_id` is empty in `deployments/testnet.json`).

To re-verify these claims against the code:

```sh
grep -rn "DataKey::Arbitrators\|DataKey::Threshold" contracts/dispute/src/lib.rs
grep -n "reclaim_after_dispute_timeout\|dispute_deadline" contracts/escrow/src/lib.rs
grep -n "IndexerCursor\|IndexerDeadLetter" backend/src/indexer.ts
grep -n "threshold" scripts/deploy_testnet.sh
grep -n "usdc_contract_id" deployments/testnet.json
```
