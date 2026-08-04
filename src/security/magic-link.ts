/**
 * Magic-link login tokens.
 *
 * Flow:
 *   1. User enters email on /login → server generates a 32-byte token, hashes
 *      it, stores hash + email + expires_at, emails a URL with the plaintext.
 *   2. User clicks the link → server hashes the token in the URL, looks up
 *      the row, checks not expired/consumed, marks consumed_at, creates a
 *      web session, sets cookie, redirects to /dashboard.
 *   3. Same token can't be used twice (UNIQUE index on token_hash + check on
 *      consumed_at).
 *
 * Rate limits:
 *   - Max 5 login requests per email per hour. Enforced by counting recent
 *     magic_links rows for the email.
 *   - Old tokens are pruned opportunistically to keep the table small.
 */

import { createHash, randomBytes } from "node:crypto";
import { sqlAsAdmin } from "../neon/client.js";

const TOKEN_BYTES = 32;
const TOKEN_TTL_MIN = 15;
const MAX_PER_HOUR = 5;

export class TooManyLoginsError extends Error {
  constructor() {
    super("too_many_login_attempts");
    this.name = "TooManyLoginsError";
  }
}

function hash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Create and persist a magic link. Returns the plaintext token to embed in
 * the email URL. Throws TooManyLoginsError if the email has exceeded its
 * rate limit.
 */
export async function issueMagicLink(
  email: string,
  ipHash: Buffer | null
): Promise<string> {
  const normalized = email.trim().toLowerCase();

  const recent = await sqlAsAdmin((c) =>
    c.query<{ n: string }>(
      `SELECT count(*) AS n
         FROM magic_links
        WHERE email = $1 AND created_at > now() - interval '1 hour'`,
      [normalized]
    )
  );
  if (parseInt(recent.rows[0]?.n ?? "0", 10) >= MAX_PER_HOUR) {
    throw new TooManyLoginsError();
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = hash(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MIN * 60_000);

  await sqlAsAdmin((c) =>
    c.query(
      `INSERT INTO magic_links (email, token_hash, expires_at, ip_hash)
       VALUES ($1, $2, $3, $4)`,
      [normalized, tokenHash, expiresAt, ipHash]
    )
  );

  // Prune old consumed/expired rows opportunistically.
  sqlAsAdmin((c) =>
    c.query(
      `DELETE FROM magic_links
        WHERE (expires_at < now() - interval '1 day')
           OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '7 days')`
    )
  ).catch(() => undefined);

  return token;
}

export type ConsumeResult =
  | { ok: true; email: string }
  | { ok: false; reason: "not_found" | "expired" | "consumed" };

/** Verify and single-use consume a magic link. */
export async function consumeMagicLink(token: string): Promise<ConsumeResult> {
  const tokenHash = hash(token);
  return sqlAsAdmin(async (c) => {
    await c.query("BEGIN");
    try {
      const found = await c.query<{
        id: number;
        email: string;
        expires_at: Date;
        consumed_at: Date | null;
      }>(
        `SELECT id, email, expires_at, consumed_at
           FROM magic_links
          WHERE token_hash = $1
          FOR UPDATE`,
        [tokenHash]
      );
      const row = found.rows[0];
      if (!row) {
        await c.query("ROLLBACK");
        return { ok: false, reason: "not_found" };
      }
      if (row.consumed_at) {
        await c.query("ROLLBACK");
        return { ok: false, reason: "consumed" };
      }
      if (row.expires_at.getTime() < Date.now()) {
        await c.query("ROLLBACK");
        return { ok: false, reason: "expired" };
      }
      await c.query(`UPDATE magic_links SET consumed_at = now() WHERE id = $1`, [
        row.id,
      ]);
      await c.query("COMMIT");
      return { ok: true, email: row.email };
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  });
}

/** Public constants — helpful for tests and docs. */
export const _config = { TOKEN_BYTES, TOKEN_TTL_MIN, MAX_PER_HOUR };
