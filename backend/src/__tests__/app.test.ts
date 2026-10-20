import { describe, it, expect, vi } from "vitest";
import type { Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { isValidStellarAddress } from "../lib/stellarAddress";
import { createJobSchema } from "../lib/schemas";
import { jsonReplacer } from "../lib/json";
import { MAX_JOB_TAGS, SKILL_TAG_SLUGS } from "../lib/tags";

// Pure unit tests against real modules; no DB or env vars required.
// Integration tests requiring a live DB belong in a separate test suite
// run against a real environment (see CONTRIBUTING.md).

// Two checksum-valid account ids: Circle's Stellar testnet USDC issuer and the
// admin of the deployments in deployments/testnet.json.
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const DEPLOY_ADMIN = "GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B";

// Health endpoint operational checks (issue #93)

describe("GET /health", () => {
  it("returns 200 with status ok when DB and indexer are healthy", async () => {
    const { prisma } = await import("../db");
    vi.spyOn(prisma, "$queryRaw").mockResolvedValueOnce([{ "?column?": 1 }]);
    vi.spyOn(prisma.indexerCursor, "findUnique").mockResolvedValue({
      id: "main",
      lastLedger: 100,
      updatedAt: new Date(),
    } as any);

    let server!: Server;
    const { createApp } = await import("../app");
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port assigned");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; db: boolean; indexer: boolean };
    expect(body.status).toBe("ok");
    expect(body.db).toBe(true);
    expect(body.indexer).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns 503 when database is unreachable", async () => {
    const { prisma } = await import("../db");
    vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("Connection refused"));
    
    let server!: Server;
    const { createApp } = await import("../app");
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port assigned");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; db: boolean; indexer: boolean };
    expect(body.status).toBe("unhealthy");
    expect(body.db).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
  });
});


describe("stellar address validation", () => {
  it("accepts checksum-valid G addresses", () => {
    expect(isValidStellarAddress(USDC_ISSUER)).toBe(true);
    expect(isValidStellarAddress(DEPLOY_ADMIN)).toBe(true);
    expect(isValidStellarAddress(Keypair.random().publicKey())).toBe(true);
  });

  it("rejects strings that are not 56-character account strkeys", () => {
    // The 55-character fixture this file used to assert on (via a locally
    // defined lambda) is one character short of a real strkey, so it was
    // never a valid Stellar address.
    expect(
      isValidStellarAddress("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"),
    ).toBe(false);
    expect(isValidStellarAddress(USDC_ISSUER.slice(0, 55))).toBe(false);
    expect(isValidStellarAddress(`${USDC_ISSUER}A`)).toBe(false);
    expect(isValidStellarAddress("")).toBe(false);
    expect(isValidStellarAddress("not-an-address")).toBe(false);
    // A contract address (C…) is not an account (G…), even though it is a
    // well-formed strkey of the same length.
    expect(
      isValidStellarAddress("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM"),
    ).toBe(false);
  });

  it("rejects the wrong alphabet or a broken checksum", () => {
    expect(isValidStellarAddress(USDC_ISSUER.toLowerCase())).toBe(false);
    // '0', '1', '8', '9' are not base32 characters.
    expect(isValidStellarAddress("G" + "0".repeat(55))).toBe(false);
    // Same length and alphabet, last character flipped: the CRC16 fails.
    expect(isValidStellarAddress(DEPLOY_ADMIN.slice(0, -1) + "A")).toBe(false);
  });
});

describe("POST /api/jobs request validation", () => {
  const valid = {
    title: "Landing page redesign",
    description: "What needs to be delivered by Friday",
    milestones: [{ amount: 1.5, description: "Milestone 1" }],
  };

  it("accepts a minimal job and defaults the asset to USDC", () => {
    const parsed = createJobSchema.parse(valid);
    expect(parsed.asset).toBe("USDC");
    expect(parsed.milestones).toHaveLength(1);
  });

  it("rejects zero and negative milestone amounts", () => {
    expect(
      createJobSchema.safeParse({ ...valid, milestones: [{ amount: 0 }] }).success,
    ).toBe(false);
    expect(
      createJobSchema.safeParse({ ...valid, milestones: [{ amount: -1 }] }).success,
    ).toBe(false);
  });

  it("requires at least one milestone", () => {
    expect(createJobSchema.safeParse({ ...valid, milestones: [] }).success).toBe(false);
  });

  it("keeps a caller-chosen asset symbol for the registry to look up", () => {
    expect(createJobSchema.parse({ ...valid, asset: "XLM" }).asset).toBe("XLM");
  });

  it("accepts an exact decimal string amount", () => {
    // A string reaches the server as typed; the route sums it in base units so
    // 0.1 + 0.2 stores 0.3 rather than 0.30000000000000004.
    const parsed = createJobSchema.parse({
      ...valid,
      milestones: [{ amount: "0.1" }, { amount: "0.2" }],
    });
    expect(parsed.milestones.map((m) => m.amount)).toEqual(["0.1", "0.2"]);
  });

  it("rejects a zero, negative, or malformed string amount", () => {
    for (const amount of ["0", "0.0", "-1", "1e3", "abc", ""]) {
      expect(
        createJobSchema.safeParse({ ...valid, milestones: [{ amount }] }).success,
      ).toBe(false);
    }
  });
});

describe("POST /api/jobs skill tags", () => {
  const valid = {
    title: "Landing page redesign",
    description: "What needs to be delivered by Friday",
    milestones: [{ amount: 1.5 }],
  };

  it("defaults to no tags, so an older client keeps working", () => {
    expect(createJobSchema.parse(valid).tags).toEqual([]);
  });

  it("accepts curated slugs", () => {
    const parsed = createJobSchema.parse({ ...valid, tags: ["web-development", "devops"] });
    expect(parsed.tags).toEqual(["web-development", "devops"]);
  });

  it("de-duplicates the same tag sent twice", () => {
    expect(createJobSchema.parse({ ...valid, tags: ["marketing", "marketing"] }).tags).toEqual([
      "marketing",
    ]);
  });

  it("rejects a tag outside the curated list", () => {
    expect(createJobSchema.safeParse({ ...valid, tags: ["moon-shot"] }).success).toBe(false);
  });

  it("rejects more tags than the cap", () => {
    const tooMany = SKILL_TAG_SLUGS.slice(0, MAX_JOB_TAGS + 1);
    expect(createJobSchema.safeParse({ ...valid, tags: tooMany }).success).toBe(false);
  });
});

describe("jsonReplacer", () => {
  it("serializes a BigInt column as a string instead of throwing", () => {
    // Prisma returns escrowId as a BigInt; JSON.stringify would otherwise throw
    // and turn a successful write into a 500.
    const job = { id: "job_1", escrowId: 7n, onChainId: 9_007_199_254_740_993n };

    expect(JSON.stringify(job, jsonReplacer)).toBe(
      '{"id":"job_1","escrowId":"7","onChainId":"9007199254740993"}',
    );
  });

  it("leaves other values, including a Decimal's own JSON form, untouched", () => {
    const row = { total: "2.5", nested: { released: false }, missing: null };
    expect(JSON.stringify(row, jsonReplacer)).toBe(JSON.stringify(row));
  });
});
