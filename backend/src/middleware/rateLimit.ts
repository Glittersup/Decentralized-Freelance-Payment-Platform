import rateLimit from "express-rate-limit";

/**
 * A limiter for the wallet-auth endpoints (issue #44).
 *
 * `app.ts` applies one global limiter (100/min/IP) to every route. That is too
 * loose for `GET /api/users/challenge` and `POST /api/users/auth`: issuing a
 * nonce writes to the database, and a signature attempt is the endpoint an
 * attacker scripts. The global cap alone let one IP trigger 100 nonce writes —
 * or make 100 signature attempts — every minute.
 *
 * Each call returns a *new* limiter, so mount one per route: the counters are
 * then independent and exhausting the challenge budget cannot lock a user out
 * of the auth call that completes the flow.
 *
 * The response is JSON (`{ error }`) like the rest of the API; the library's
 * default is a bare-text "Too many requests", which a client parsing errors
 * would not understand.
 */
export function createAuthRateLimiter(options: { windowMs: number; max: number }) {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Too many authentication attempts. Try again later.",
    },
  });
}
