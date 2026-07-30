/**
 * Neon Postgres client, RLS-aware.
 *
 * Two clients:
 *   * `sqlAsUser(userId, cb)` — runs `cb` inside a transaction that has set
 *     `app.user_id`. Every user-scoped query MUST go through this. If code
 *     forgets, RLS returns zero rows (because app.user_id is NULL).
 *   * `sqlAsAdmin(cb)` — for provisioning tables like `users`/`api_keys`
 *     that aren't RLS-tenant-scoped. Used only by CLI scripts.
 *
 * Connection strategy:
 *   We use @neondatabase/serverless Pool. Its connection is over WebSockets
 *   so it plays well with Vercel serverless functions (short-lived processes,
 *   many parallel invocations, no TCP pool warmup).
 */

import { Pool, type PoolClient } from "@neondatabase/serverless";

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const conn = process.env.DATABASE_URL;
  if (!conn) throw new Error("DATABASE_URL is required for the neon backend.");
  pool = new Pool({ connectionString: conn });
  return pool;
}

/**
 * Test / demo hook: inject a pre-built pool (e.g. an in-memory fake) so we
 * don't need a real Neon connection. NEVER call this in production paths.
 */
export function _setPoolForTests(p: Pool | null): void {
  pool = p;
}

/**
 * Run `fn` inside a transaction where `app.user_id` is set to `userId`
 * via `set_config(..., true)` so it scopes to this transaction only.
 * COMMITs on success, ROLLBACKs on any thrown error.
 */
export async function sqlAsUser<T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  if (!isUuid(userId)) {
    throw new Error(`invalid userId (not a uuid): ${redact(userId)}`);
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // set_config with is_local=true → applies only for this transaction.
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Admin path for identity-plane tables (users, api_keys). Does NOT set
 * app.user_id and thus does not benefit from RLS — reserved for CLI scripts
 * that run under an operator's control.
 */
export async function sqlAsAdmin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Best-effort disposal for tests / graceful shutdown. */
export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end().catch(() => undefined);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}
function redact(v: string): string {
  return v.length > 16 ? v.slice(0, 8) + "…" : v;
}
