import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function hintFor(message: string): string | null {
  if (/OPENAI_API_KEY/i.test(message)) {
    return "Set OPENAI_API_KEY in the deployment environment.";
  }
  if (/DATABASE_URL|neon|postgres/i.test(message) && /connect|ECONNREFUSED|timeout/i.test(message)) {
    return "Check DATABASE_URL (use Neon's pooled connection string).";
  }
  if (/unauthorized|AuthError/i.test(message)) {
    return "Check the Bearer API key. Create or rotate keys in the dashboard.";
  }
  return null;
}

export function toolError(prefix: string, err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const hint = hintFor(message);
  const text = hint ? `${prefix}: ${message}\nHint: ${hint}` : `${prefix}: ${message}`;
  return { content: [{ type: "text", text }], isError: true };
}
