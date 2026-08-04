/**
 * Web session (cookie-based, DB-backed).
 *
 * Design:
 *   - Session token = 32 random bytes, base64url. Sent to the client as an
 *     HttpOnly cookie. NEVER stored in JS-readable storage.
 *   - Server stores SHA-256(token) so a DB dump can't hijack live sessions.
 *   - Sessions live in web_sessions; revocation is a DB update. No JWTs.
 *   - Cookie flags: HttpOnly, Secure (in prod), SameSite=Strict, Path=/.
 *   - Expiry: 30 days sliding (last_used_at bumped on each use).
 *
 * Why not JWT?
 *   Server-side revocability. If a laptop is stolen, revoke the session in
 *   the DB and it's dead within one request. JWTs would still be valid until
 *   their embedded exp.
 */

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sqlAsAdmin } from "../neon/client.js";

const COOKIE_NAME = "sv_session";
const TOKEN_BYTES = 32;
const SESSION_TTL_DAYS = 30;
const PROD =
  process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";

export type WebSession = {
  id: string;
  userId: string;
};

function hash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function newSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Persist a session and return the plaintext cookie value. */
export async function createWebSession(
  userId: string,
  ipHash: Buffer | null,
  uaHash: Buffer | null
): Promise<{ token: string; sessionId: string }> {
  const token = newSessionToken();
  const cookieHash = hash(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  const res = await sqlAsAdmin((c) =>
    c.query<{ id: string }>(
      `INSERT INTO web_sessions (user_id, cookie_hash, expires_at, ip_hash, ua_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [userId, cookieHash, expiresAt, ipHash, uaHash]
    )
  );
  return { token, sessionId: res.rows[0]!.id };
}

/** Look up a session by cookie token, refreshing last_used_at. */
export async function loadWebSession(token: string): Promise<WebSession | null> {
  const cookieHash = hash(token);
  const res = await sqlAsAdmin((c) =>
    c.query<{ id: string; user_id: string; expires_at: Date; revoked_at: Date | null }>(
      `SELECT id, user_id, expires_at, revoked_at
         FROM web_sessions
        WHERE cookie_hash = $1
        LIMIT 1`,
      [cookieHash]
    )
  );
  const row = res.rows[0];
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at.getTime() < Date.now()) return null;

  // Best-effort refresh; a stale row would only shorten session by <1 request.
  sqlAsAdmin((c) =>
    c.query(`UPDATE web_sessions SET last_used_at = now() WHERE id = $1`, [row.id])
  ).catch(() => undefined);

  return { id: row.id, userId: row.user_id };
}

export async function revokeWebSession(sessionId: string): Promise<void> {
  await sqlAsAdmin((c) =>
    c.query(`UPDATE web_sessions SET revoked_at = now() WHERE id = $1`, [sessionId])
  );
}

/** Parse the session cookie from a request. Returns null if absent/malformed. */
export function readSessionCookie(req: IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) {
      const v = rest.join("=");
      // Base64url alphabet only, plausible length.
      if (!v || v.length < 40 || v.length > 128) return null;
      if (!/^[A-Za-z0-9_-]+$/.test(v)) return null;
      return v;
    }
  }
  return null;
}

export function setSessionCookie(res: ServerResponse, token: string): void {
  const flags: string[] = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_DAYS * 86_400}`,
  ];
  if (PROD) flags.push("Secure");
  appendCookie(res, flags.join("; "));
}

export function clearSessionCookie(res: ServerResponse): void {
  const flags: string[] = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (PROD) flags.push("Secure");
  appendCookie(res, flags.join("; "));
}

function appendCookie(res: ServerResponse, value: string): void {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) return void res.setHeader("Set-Cookie", value);
  const arr = Array.isArray(existing) ? existing : [String(existing)];
  arr.push(value);
  res.setHeader("Set-Cookie", arr);
}

/**
 * Require a valid session or return a redirect/401. Handlers that need auth
 * call this at the top and bail if it returns null.
 */
export async function requireSession(
  req: IncomingMessage,
  res: ServerResponse
): Promise<WebSession | null> {
  const token = readSessionCookie(req);
  if (!token) {
    res.statusCode = 302;
    res.setHeader("Location", "/login");
    res.end();
    return null;
  }
  const session = await loadWebSession(token);
  if (!session) {
    clearSessionCookie(res);
    res.statusCode = 302;
    res.setHeader("Location", "/login");
    res.end();
    return null;
  }
  return session;
}
