/**
 * Unknown paths must answer JSON, not Express's default HTML 404 (issue #50).
 *
 * `app.ts` mounts the routers and then the error handler, but until this
 * change nothing handled a path that matched no router: it fell through to
 * Express's final handler, which replies with `text/html`
 * (`Cannot GET /api/typo`). Every real route answers JSON, so a client doing
 * `res.json()` on the error path throws on exactly the response a typo
 * produces.
 *
 * This drives the real `createApp()`, so it fails if the catch-all is dropped
 * or moved below `errorHandler`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../app";

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("unknown routes", () => {
  it("answers an unmatched path with a 404 JSON body", async () => {
    const res = await fetch(`${baseUrl}/api/definitely-not-a-route`);

    expect(res.status).toBe(404);
    // The regression guard: Express's HTML final handler sends text/html.
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("keeps the JSON shape for unknown non-API paths and other methods", async () => {
    const get = await fetch(`${baseUrl}/nope`);
    expect(get.status).toBe(404);
    expect((get.headers.get("content-type") ?? "").includes("application/json")).toBe(true);
    expect(await get.json()).toEqual({ error: "Not found" });

    const post = await fetch(`${baseUrl}/api/jobs/not-a-real-sub-route`, { method: "POST" });
    expect(post.status).toBe(404);
    expect(await post.json()).toEqual({ error: "Not found" });
  });

  it("still answers a real route normally", async () => {
    // Guards against a catch-all mounted too early swallowing the routers.
    const res = await fetch(`${baseUrl}/health`);

    expect([200, 503]).toContain(res.status);
    const body = (await res.json()) as { status: string };
    expect(["ok", "unhealthy"]).toContain(body.status);
  });
});
