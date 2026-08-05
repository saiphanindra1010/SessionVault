/**
 * Append-only audit log writer. Called from the HTTP handler after each
 * request, and by internal auth code on denials.
 *
 * Privacy: we NEVER store raw IPs or user agents. We store SHA-256 of
 * (value + SESSIONVAULT_AUDIT_SALT). A stable salt lets us correlate abuse
 * across requests without keeping PII. Rotating the salt anonymizes history.
 */

import { createHash } from "node:crypto";
import { sqlAsUser } from "../neon/client.js";

export type AuditEvent = {
  userId: string;
  tool: string;
  sessionName?: string;
  status: "ok" | "error" | "denied";
  ip?: string;
  userAgent?: string;
  errClass?: string;
  latencyMs?: number;
};

function hash(v: string | undefined): Buffer | null {
  if (!v) return null;
  const salt = process.env.SESSIONVAULT_AUDIT_SALT || "";
  return createHash("sha256").update(v + salt, "utf8").digest();
}

export async function writeAudit(e: AuditEvent): Promise<void> {
  try {
    await sqlAsUser(e.userId, (c) =>
      c.query(
        `INSERT INTO audit_log
           (user_id, tool, session_name, status, ip_hash, ua_hash, err_class, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          e.userId,
          e.tool,
          e.sessionName ?? null,
          e.status,
          hash(e.ip),
          hash(e.userAgent),
          e.errClass ?? null,
          e.latencyMs ?? null,
        ]
      )
    );
  } catch (err) {
    // Never fail a real request because auditing failed. Log once.
    // eslint-disable-next-line no-console
    console.warn(`[audit] write failed: ${(err as Error).message || err}`);
  }
}
