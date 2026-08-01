import { loadMasterKey } from "./security/crypto.js";

/**
 * Fail fast on boot / first request if security-critical config is missing
 * or clearly weak. Used by the Next.js MCP and auth routes.
 */
export function assertHostedConfig(): void {
  const missing: string[] = [];
  if (!process.env.DATABASE_URL) missing.push("DATABASE_URL");
  if (!process.env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!process.env.SESSIONVAULT_AUDIT_SALT) missing.push("SESSIONVAULT_AUDIT_SALT");
  if (!process.env.PUBLIC_URL) missing.push("PUBLIC_URL");

  const prod =
    process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
  if (prod && !process.env.RESEND_API_KEY) {
    missing.push("RESEND_API_KEY");
  }

  if (missing.length) {
    missing.forEach((envVar) => {
      // Structured for ops / Splunk-style search without logging secret values.
      console.error(`logName=requiredEnvVarMissing, envVar=${envVar}`);
    });
    throw new Error(
      `Hosted mode requires: ${missing.join(", ")}. See .env.example.`
    );
  }

  loadMasterKey(process.env.SESSIONVAULT_MASTER_KEY);
}
