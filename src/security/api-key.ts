/**
 * API key generation, storage, and verification.
 *
 * Format:  sv_live_<32-char base64url random>
 *          ^^^^^^^^  ^^^^^^^^^^^^^^^^^^^^^^^^
 *          prefix    24 random bytes = 192 bits of entropy
 *
 * Storage:
 *   - We store SHA-256(plaintext_key) as the lookup key.
 *   - We ALSO store the first 12 chars of the plaintext ("sv_live_a1b2") as
 *     `key_prefix` so a future dashboard can display "sv_live_a1b2… (laptop)"
 *     without ever showing the full secret.
 *
 * Timing safety:
 *   Because we look up by an indexed hash column, the DB returns the row
 *   (or not) in a way that does not leak per-byte comparison timing. There
 *   is no need for a userland `timingSafeEqual` here — the crypto hash is
 *   collision-resistant and the lookup is a single index probe.
 *
 * Revocation:
 *   Setting `revoked_at IS NOT NULL` disables a key. We keep the row so
 *   audit_log can still reference it.
 */

import { createHash, randomBytes } from "node:crypto";

export const KEY_PREFIX = "sv_live_";
/** Length of the plaintext prefix we retain (public, non-secret). */
export const KEY_PREFIX_STORED = 12;

/** Generate a fresh API key. Show to the user exactly once. */
export function generateApiKey(): string {
  // 24 bytes base64url ≈ 32 chars, no padding.
  const random = randomBytes(24).toString("base64url");
  return `${KEY_PREFIX}${random}`;
}

/** SHA-256 hash of the key as a Buffer (matches Postgres BYTEA). */
export function hashApiKey(plaintext: string): Buffer {
  return createHash("sha256").update(plaintext, "utf8").digest();
}

/** Public prefix stored in the DB for human identification of keys. */
export function keyPrefix(plaintext: string): string {
  return plaintext.substring(0, KEY_PREFIX_STORED);
}

/**
 * Extract the bearer token from an Authorization header. Returns null on
 * missing/malformed input. We deliberately don't distinguish "missing" vs
 * "malformed" upstream to avoid leaking whether a header was present.
 */
export function parseBearer(authHeader: string | string[] | undefined): string | null {
  if (!authHeader) return null;
  const h = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!h) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(h.trim());
  if (!match) return null;
  const token = match[1]!;
  if (!token.startsWith(KEY_PREFIX)) return null;
  if (token.length < KEY_PREFIX.length + 20) return null; // sanity
  return token;
}
