/**
 * Web-standard (Fetch API) session helpers for the Next.js App Router.
 * Reuses the same DB-backed sessions as the legacy Node handlers.
 */

import { createHash } from "node:crypto";
import {
  createWebSession,
  loadWebSession,
  revokeWebSession,
  type WebSession,
} from "@/src/security/session";

export const COOKIE_NAME = "sv_session";
const SESSION_TTL_DAYS = 30;
const PROD =
  process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";

export { createWebSession, loadWebSession, revokeWebSession };
export type { WebSession };

export function readSessionToken(request: Request): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) {
      const v = rest.join("=");
      if (!v || v.length < 40 || v.length > 128) return null;
      if (!/^[A-Za-z0-9_-]+$/.test(v)) return null;
      return v;
    }
  }
  return null;
}

export function sessionCookieHeader(token: string): string {
  const flags = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_DAYS * 86_400}`,
  ];
  if (PROD) flags.push("Secure");
  return flags.join("; ");
}

export function clearSessionCookieHeader(): string {
  const flags = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (PROD) flags.push("Secure");
  return flags.join("; ");
}

export async function requireWebSession(
  request: Request
): Promise<WebSession | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  return loadWebSession(token);
}

export function isOriginAllowed(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const expected = process.env.PUBLIC_URL;
  if (expected) {
    const exp = expected.replace(/\/+$/, "");
    if (origin && origin.replace(/\/+$/, "") === exp) return true;
    if (!origin && referer && referer.startsWith(`${exp}/`)) return true;
    return false;
  }
  if (PROD) return false;
  const host = request.headers.get("host");
  if (host && (origin === `http://${host}` || origin === `https://${host}`)) {
    return true;
  }
  if (!origin && !referer) return true;
  return false;
}

export function publicBaseUrl(request: Request): string {
  const configured = process.env.PUBLIC_URL;
  if (configured) return configured.replace(/\/+$/, "");
  const proto = request.headers.get("x-forwarded-proto") || (PROD ? "https" : "http");
  const host = request.headers.get("host") || "localhost:3000";
  return `${proto}://${host}`;
}

export function hashPII(v: string | undefined): Buffer | null {
  if (!v) return null;
  const salt = process.env.SESSIONVAULT_AUDIT_SALT || "";
  return createHash("sha256").update(v + salt, "utf8").digest();
}

export function firstIp(forwarded: string | null): string | undefined {
  if (!forwarded) return undefined;
  return forwarded.split(",")[0]!.trim() || undefined;
}

export async function readFormData(
  request: Request
): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const json = (await request.json()) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(json)) {
      if (v != null) out[k] = String(v);
    }
    return out;
  }
  const form = await request.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
