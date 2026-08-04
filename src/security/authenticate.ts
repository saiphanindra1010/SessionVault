/**
 * Authenticate a request via bearer API key.
 *
 * Steps:
 *   1. Parse `Authorization: Bearer sv_live_...` header.
 *   2. SHA-256 the token and look it up in api_keys.
 *   3. Reject if not found, revoked, or user disabled.
 *   4. Unwrap the user's DEK using the master key.
 *   5. Return a RequestUser suitable for runWithUser().
 *
 * Every failure returns the SAME error type/timing so an attacker can't
 * distinguish "no such key" from "revoked" from "user disabled". Detail is
 * logged server-side via the audit trail.
 */

import { sqlAsAdmin } from "../neon/client.js";
import { hashApiKey, parseBearer } from "./api-key.js";
import { unwrapKey, loadMasterKey } from "./crypto.js";
import type { RequestUser } from "./context.js";

export class AuthError extends Error {
  constructor(public readonly reason: string) {
    // Public message deliberately vague; `reason` is server-only.
    super("unauthorized");
    this.name = "AuthError";
  }
}

let masterKeyCache: Buffer | null = null;
function getMasterKey(): Buffer {
  if (!masterKeyCache) {
    masterKeyCache = loadMasterKey(process.env.SESSIONVAULT_MASTER_KEY);
  }
  return masterKeyCache;
}

export async function authenticate(
  authHeader: string | string[] | undefined
): Promise<RequestUser> {
  const token = parseBearer(authHeader);
  if (!token) throw new AuthError("no_bearer");

  const hash = hashApiKey(token);

  const row = await sqlAsAdmin((c) =>
    c.query<{
      user_id: string;
      key_prefix: string;
      revoked_at: Date | null;
      disabled_at: Date | null;
      dek_wrapped: Buffer;
      dek_nonce: Buffer;
    }>(
      `SELECT k.user_id, k.key_prefix, k.revoked_at,
              u.disabled_at, u.dek_wrapped, u.dek_nonce
         FROM api_keys k
         JOIN users u ON u.id = k.user_id
        WHERE k.key_hash = $1
        LIMIT 1`,
      [hash]
    )
  );

  const r = row.rows[0];
  if (!r) throw new AuthError("not_found");
  if (r.revoked_at) throw new AuthError("revoked");
  if (r.disabled_at) throw new AuthError("user_disabled");

  const dek = unwrapKey(r.dek_wrapped, r.dek_nonce, getMasterKey());

  // Best-effort touch. Don't fail auth if this fails.
  sqlAsAdmin((c) =>
    c.query(`UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1`, [
      hash,
    ])
  ).catch(() => undefined);

  return { id: r.user_id, dek, keyPrefix: r.key_prefix };
}

/** Test hook: reset the master key cache. */
export function _resetAuthCacheForTests(): void {
  masterKeyCache = null;
}
