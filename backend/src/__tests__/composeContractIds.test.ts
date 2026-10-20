import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The local compose stack must give the backend the contract ids the indexer
 * subscribes to (issue #42).
 *
 * `docker-compose.yml` set `NODE_ENV`, `DATABASE_URL`, `JWT_SECRET`,
 * `STELLAR_NETWORK`, `SOROBAN_RPC_URL` and `INDEXER_POLL_INTERVAL_MS` but no
 * `ESCROW_CONTRACT_ID` / `DISPUTE_CONTRACT_ID` / `REPUTATION_CONTRACT_ID`.
 * `startIndexer()` therefore logged "No contract IDs configured" and returned,
 * so the one-command stack never synced chain state — a local bug that no unit
 * test could see because the compose file is not executable code.
 *
 * These tests read the file compose actually consumes, so dropping an id or
 * letting a default drift from `deployments/testnet.json` fails here.
 */

/** Read a file from the repo root regardless of whether cwd is repo or backend. */
function repoFile(...segments: string[]): string {
  const cwd = process.cwd();
  const root = [cwd, path.resolve(cwd, "..")].find((dir) =>
    existsSync(path.join(dir, "docker-compose.yml")),
  );
  if (!root) throw new Error(`repo root not found from ${cwd}`);
  return readFileSync(path.join(root, ...segments), "utf8").replace(/\r/g, "");
}

interface Deployment {
  escrow_contract_id: string;
  dispute_contract_id: string;
  reputation_contract_id: string;
  xlm_contract_id: string;
  usdc_contract_id: string;
}

/**
 * The keys under a service's `environment:` block in `docker-compose.yml`.
 *
 * Only a mapping form is understood (`KEY: value`), which is what the backend
 * service uses; a list form (`- KEY=value`) would return empty here rather than
 * silently pass, because the assertions below require the keys to be present.
 */
function serviceEnvironment(compose: string, service: string): Record<string, string> {
  const lines = compose.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^ {2}${service}:\\s*$`).test(line));
  expect(start, `docker-compose.yml has no \`${service}:\` service`).toBeGreaterThanOrEqual(0);

  const environment: Record<string, string> = {};
  let inEnvironment = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // A line indented two spaces starts the next top-level key/service.
    if (/^ {2}\S/.test(line)) break;
    if (/^ {4}environment:\s*$/.test(line)) {
      inEnvironment = true;
      continue;
    }
    // Another key of the same service (build:, ports:, …) ends the block.
    if (/^ {4}\S/.test(line)) {
      inEnvironment = false;
      continue;
    }
    if (!inEnvironment) continue;

    const entry = /^ {6}([A-Z0-9_]+):\s*(.*)$/.exec(line);
    if (entry) environment[entry[1]] = entry[2].trim();
  }
  return environment;
}

/** The fallback in `${VAR:-fallback}`, or null when the value is not a default. */
function defaultOf(value: string): string | null {
  const match = /^\$\{[A-Z0-9_]+:-(.*)\}$/.exec(value);
  return match ? match[1] : null;
}

const compose = repoFile("docker-compose.yml");
const backendEnv = serviceEnvironment(compose, "backend");
const deployment = JSON.parse(repoFile("deployments", "testnet.json")) as Deployment;

describe("docker-compose.yml backend contract ids", () => {
  it("forwards the three contract ids the indexer needs", () => {
    expect(Object.keys(backendEnv)).toEqual(
      expect.arrayContaining([
        "ESCROW_CONTRACT_ID",
        "DISPUTE_CONTRACT_ID",
        "REPUTATION_CONTRACT_ID",
      ]),
    );
  });

  it("defaults each id to the deployment recorded in deployments/testnet.json", () => {
    expect(defaultOf(backendEnv.ESCROW_CONTRACT_ID)).toBe(deployment.escrow_contract_id);
    expect(defaultOf(backendEnv.DISPUTE_CONTRACT_ID)).toBe(deployment.dispute_contract_id);
    expect(defaultOf(backendEnv.REPUTATION_CONTRACT_ID)).toBe(deployment.reputation_contract_id);
  });

  it("lets the operator point the stack at another deployment", () => {
    // A `${VAR:-…}` value is overridable from the shell or a root `.env`; a
    // hard-coded id would make redeploying the contracts require editing the file.
    for (const key of [
      "ESCROW_CONTRACT_ID",
      "DISPUTE_CONTRACT_ID",
      "REPUTATION_CONTRACT_ID",
      "XLM_CONTRACT_ID",
      "USDC_CONTRACT_ID",
    ]) {
      expect(backendEnv[key], `${key} is not overridable`).toMatch(/^\$\{[A-Z0-9_]+:-.*\}$/);
    }
  });

  it("keeps the SAC ids consistent with the recorded deployment", () => {
    expect(defaultOf(backendEnv.XLM_CONTRACT_ID)).toBe(deployment.xlm_contract_id);
    expect(defaultOf(backendEnv.USDC_CONTRACT_ID)).toBe(deployment.usdc_contract_id);
  });
});

describe("contract id documentation", () => {
  it("README's Docker section names the ids and how to override them", () => {
    const readme = repoFile("README.md");
    const start = readme.indexOf("### One command (Docker)");
    expect(start).toBeGreaterThan(-1);
    const section = readme.slice(start, readme.indexOf("### Manual", start));

    expect(section).toContain("ESCROW_CONTRACT_ID");
    expect(section).toContain("DISPUTE_CONTRACT_ID");
    expect(section).toContain("REPUTATION_CONTRACT_ID");
    expect(section).toMatch(/deployments\/testnet\.json/);
  });

  it("docs/DEPLOYMENT.md documents pointing the compose stack at a deployment", () => {
    const deploymentDoc = repoFile("docs", "DEPLOYMENT.md");

    expect(deploymentDoc).toContain("### Contract ids in the compose stack");
    expect(deploymentDoc).toMatch(/docker compose up/);
    expect(deploymentDoc).toContain("ESCROW_CONTRACT_ID");
    expect(deploymentDoc).toMatch(/No contract IDs configured/);
  });
});
