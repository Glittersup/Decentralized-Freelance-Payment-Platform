/**
 * Structured request logging (issue #27).
 *
 * The API had no access log, so there was no record of requests or latency.
 * These tests pin the two halves of the contract: a request produces exactly one
 * JSON line with the fields worth alerting on, and the logger stays out of the
 * test suite (the app is built with NODE_ENV=test by vitest.config.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Request, type Response } from "express";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { createApp, requestLogger } from "../app";

describe("requestLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits one structured line with method, path, status and duration", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    const req = { method: "POST", originalUrl: "/api/jobs?status=ACTIVE" } as Request;
    const res = new EventEmitter() as unknown as Response & EventEmitter;
    (res as unknown as { statusCode: number }).statusCode = 201;
    const next = vi.fn();

    requestLogger()(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    // Nothing is logged until the response is actually finished.
    expect(lines).toHaveLength(0);

    res.emit("finish");

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: "info",
      event: "http_request",
      method: "POST",
      path: "/api/jobs?status=ACTIVE",
      status: 201,
    });
    expect(typeof entry.durationMs).toBe("number");
    expect(entry.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  it("is not installed on the app under NODE_ENV=test", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const app = createApp();
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });

    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port assigned");
      const res = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect([200, 503]).toContain(res.status);
      await res.json();
      // A request completed end to end and produced no access-log line.
      const httpLogs = log.mock.calls.filter(
        ([arg]) => typeof arg === "string" && arg.includes('"event":"http_request"'),
      );
      expect(httpLogs).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
