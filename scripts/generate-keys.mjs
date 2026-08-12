#!/usr/bin/env node
/**
 * Print fresh secrets for a Vercel deployment. Copy each line into your
 * Vercel project's Environment Variables settings.
 *
 * Usage:
 *   npm run sv:generate-keys
 */
import { randomBytes } from "node:crypto";

function b64(n) {
  return randomBytes(n).toString("base64");
}
function urlsafe(n) {
  return randomBytes(n).toString("base64url");
}

console.log("");
console.log("# Copy these into Vercel > Project > Settings > Environment Variables");
console.log("# (Or into your local .env for local hosted-mode testing.)");
console.log("");
console.log(`SESSIONVAULT_MASTER_KEY=${b64(32)}`);
console.log(`SESSIONVAULT_AUDIT_SALT=${urlsafe(16)}`);
console.log("");
console.log("# You will also need to set (not generated here):");
console.log("#   DATABASE_URL=postgres://...  (Neon)");
console.log("#   OPENAI_API_KEY=sk-...");
console.log("#   PUBLIC_URL=https://your-deployment.vercel.app  (for CSRF + magic-link URLs)");
console.log("#   RESEND_API_KEY=re_...  (for magic-link emails; optional in dev)");
console.log("");
console.log("# Never regenerate SESSIONVAULT_MASTER_KEY on an existing deployment");
console.log("# without following the master-key rotation runbook (see SECURITY.md).");
console.log("");
