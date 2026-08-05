/**
 * Security-relevant HTTP response headers. Kept in one place so audits are
 * easy. Applied to every response from the Vercel handler.
 */

import type { ServerResponse } from "node:http";

const HEADERS: Record<string, string> = {
  // Force HTTPS forever + include subdomains + preload eligible.
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  // Never let a browser guess the content type of a response.
  "X-Content-Type-Options": "nosniff",
  // MCP responses can contain user data — do not leak referrer.
  "Referrer-Policy": "no-referrer",
  // No caching intermediaries.
  "Cache-Control": "no-store",
  // We don't render user content in a frame anywhere; be defensive.
  "X-Frame-Options": "DENY",
  // MCP clients call us over HTTP, not from a browser — deny cross-origin.
  "Access-Control-Allow-Origin": "null",
  // Minimal CSP for the plain JSON endpoint.
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  // Advertise the server sparingly.
  "X-SessionVault-Version": "2.0.0",
};

export function applySecurityHeaders(res: ServerResponse): void {
  for (const [k, v] of Object.entries(HEADERS)) {
    if (!res.hasHeader(k)) res.setHeader(k, v);
  }
}
