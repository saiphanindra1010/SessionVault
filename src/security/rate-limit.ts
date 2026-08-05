/**
 * DB-backed sliding-window rate limit. Kept simple (one query per check,
 * one query per record) so we don't introduce a Redis dependency.
 *
 * Limits are conservative defaults; override with env vars:
 *   SESSIONVAULT_RL_PER_MIN  (default 60)
 *   SESSIONVAULT_RL_PER_DAY  (default 1000)
 *
 * We keep the window narrow enough that occasional row growth is fine, and
 * every check opportunistically prunes old rows for the caller. That means
 * an inactive user's rows disappear the next time they DO make a request,
 * which is what we want (no background job needed).
 */

import { sqlAsUser } from "../neon/client.js";

export class RateLimitError extends Error {
  constructor(
    public readonly retryAfterSeconds: number,
    public readonly window: "minute" | "day"
  ) {
    super(
      `Rate limit exceeded (${window} window). Retry in ${retryAfterSeconds}s.`
    );
    this.name = "RateLimitError";
  }
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; window: "minute" | "day" };

function limit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function checkRateLimit(userId: string): Promise<RateLimitDecision> {
  const perMin = limit("SESSIONVAULT_RL_PER_MIN", 60);
  const perDay = limit("SESSIONVAULT_RL_PER_DAY", 1000);

  return sqlAsUser(userId, async (c) => {
    // Prune anything older than the widest window.
    await c.query(
      `DELETE FROM rate_limits
        WHERE user_id = $1 AND ts < now() - interval '1 day'`,
      [userId]
    );
    // Count in each window.
    const { rows } = await c.query<{
      minute_count: string;
      day_count: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE ts > now() - interval '1 minute') AS minute_count,
         count(*)                                                 AS day_count
       FROM rate_limits WHERE user_id = $1`,
      [userId]
    );
    const minute = parseInt(rows[0]?.minute_count ?? "0", 10);
    const day = parseInt(rows[0]?.day_count ?? "0", 10);

    if (minute >= perMin) return { allowed: false, retryAfterSeconds: 60, window: "minute" };
    if (day >= perDay) return { allowed: false, retryAfterSeconds: 3600, window: "day" };

    // Record this request.
    await c.query(
      `INSERT INTO rate_limits (user_id) VALUES ($1)`,
      [userId]
    );
    return { allowed: true };
  });
}
