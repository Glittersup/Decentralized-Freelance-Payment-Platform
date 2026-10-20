import express, { type RequestHandler } from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";

import { config } from "./config";
import { prisma } from "./db";
import { docsEnabled, openApiDocument } from "./openapi";
import { isAllowedOrigin, parseList } from "./lib/access";
import { jsonReplacer } from "./lib/json";
import { errorHandler } from "./middleware/errorHandler";
import { notFoundHandler } from "./middleware/notFound";
import { createAuthRateLimiter } from "./middleware/rateLimit";
import { usersRouter } from "./routes/users";
import { jobsRouter } from "./routes/jobs";
import { escrowRouter } from "./routes/escrow";
import { disputesRouter } from "./routes/disputes";
import { reputationRouter } from "./routes/reputation";
import { notificationsRouter } from "./routes/notifications";
import { milestonesRouter } from "./routes/milestones";

/**
 * Access logging (issue #27).
 *
 * The API emitted no access log at all, so there was no record of what was
 * requested or how long it took. Emit one structured JSON line per request — a
 * log collector can index it without a parser, unlike an ad-hoc `console.log`
 * or a pair-format string.
 *
 * `path` is `originalUrl` (query string included) rather than `req.url`, because
 * the router rewrites `req.url` before `finish` fires and the query is often the
 * interesting part of a report. `durationMs` is wall-clock from the first byte
 * in to the response's `finish`, so it covers time spent in every handler.
 */
export function requestLogger(): RequestHandler {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      console.log(
        JSON.stringify({
          level: "info",
          event: "http_request",
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: Number(durationMs.toFixed(3)),
        }),
      );
    });
    next();
  };
}

export function createApp() {
  const app = express();

  if (config.TRUST_PROXY > 0) {
    app.set("trust proxy", config.TRUST_PROXY);
  }

  // OpenAPI description + explorer (issue #61). Mounted ahead of helmet because
  // the bundled Swagger UI bootstraps itself with an inline script, which
  // helmet's default Content-Security-Policy would block. The routes are only
  // registered outside production, so a deployed instance exposes neither.
  if (docsEnabled) {
    app.get("/api/docs/openapi.json", (_req, res) => res.json(openApiDocument));
    app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
  }

  app.use(helmet());

  // CORS_ORIGIN is a comma-separated allowlist of browser origins. When it is
  // unset we keep the permissive development behaviour, but saying so out loud
  // in production beats silently exposing the API to every origin.
  const allowedOrigins = parseList(config.CORS_ORIGIN);
  if (allowedOrigins.length === 0 && config.NODE_ENV === "production") {
    console.warn(
      "[cors] CORS_ORIGIN is unset in production — every origin may call this API. " +
        "Set it to your frontend origin, e.g. CORS_ORIGIN=https://your-app.vercel.app",
    );
  }
  app.use(
    cors({
      origin: (origin, callback) =>
        isAllowedOrigin(origin ?? undefined, allowedOrigins)
          ? callback(null, true)
          : callback(null, false),
    }),
  );

  app.use(express.json({ limit: "10mb" }));
  // Prisma rows carry BigInt ids, which `JSON.stringify` throws on; without this
  // any route that returns a job or dispute row would 500 after a successful write.
  app.set("json replacer", jsonReplacer);
  app.use(rateLimit({ windowMs: 60_000, max: 100 }));

  // Wallet auth gets a tighter, dedicated budget on top of the global limiter
  // (issue #44). Challenge issuance writes a nonce row, and /auth is where an
  // attacker scripts signature attempts, so 100/min/IP was far too loose. One
  // limiter per route means the two counters are independent: exhausting the
  // challenge budget cannot block the auth call that completes the flow.
  const authLimit = {
    windowMs: config.AUTH_RATE_LIMIT_WINDOW_MS,
    max: config.AUTH_RATE_LIMIT_MAX,
  };
  app.use("/api/users/challenge", createAuthRateLimiter(authLimit));
  app.use("/api/users/auth", createAuthRateLimiter(authLimit));

  app.get("/health", async (_req, res) => {
  const dbOk = await checkDbHealth();
  const indexerOk = await checkIndexerHealth();

  if (!dbOk || !indexerOk) {
    return res.status(503).json({
      status: "unhealthy",
      db: dbOk,
      indexer: indexerOk,
    });
  }

  // Also check indexer staleness: if cursor hasn't advanced recently,
  // return degraded status even if indexer is running
  const indexerStale = await checkIndexerStaleness();
  if (indexerStale) {
    return res.status(200).json({
      status: "degraded",
      db: true,
      indexer: false,
      message: "Indexer has not advanced recently",
    });
  }

  return res.json({ status: "ok", db: true, indexer: true });
});

  app.use("/api/users", usersRouter);
  app.use("/api/jobs", jobsRouter);
  app.use("/api/milestones", milestonesRouter);
  app.use("/api/escrow", escrowRouter);
  app.use("/api/disputes", disputesRouter);
  app.use("/api/reputation", reputationRouter);
  app.use("/api/notifications", notificationsRouter);

  // Unmatched paths fall through to Express's built-in final handler, which
  // answers HTML — unlike every route above. Answer them as JSON instead.
  app.use(notFoundHandler);

  app.use(errorHandler);

  return app;
}

/**
 * Check if the indexer cursor has advanced beyond a reasonable threshold.
 * Returns true if the indexer appears stuck (cursor at 0 or hasn't advanced in a while). */
async function checkIndexerStaleness(): Promise<boolean> {
  try {
    const cursor = await prisma.indexerCursor.findUnique({ where: { id: "main" } });
    if (!cursor) return true; // no cursor table yet
    // If cursor is at 0, the indexer has never successfully polled
    if (cursor.lastLedger === 0) return true;
    // If the cursor hasn't been updated in over 24h, consider it stale
    const now = Date.now();
    const lastUpdated = new Date(cursor.updatedAt).getTime();
    const stalenessThreshold = 24 * 60 * 60 * 1000; // 24 hours
    if (now - lastUpdated > stalenessThreshold) return true;
    return false;
  } catch {
    // If we can't read the cursor, assume stale (conservative)
    return true;
  }
}

/** Check database connectivity with a cheap query */
async function checkDbHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/** Check indexer health by reading the cursor */
async function checkIndexerHealth(): Promise<boolean> {
  try {
    const cursor = await prisma.indexerCursor.findUnique({ where: { id: "main" } });
    return !!(cursor && cursor.lastLedger > 0);
  } catch {
    return false;
  }
}
