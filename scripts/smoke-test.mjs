/**
 * Smoke test against a deployed (or local next) SessionVault instance.
 *
 * Usage:
 *   PUBLIC_URL=https://your-app.vercel.app \
 *   SESSIONVAULT_API_KEY=sv_live_... \
 *   node scripts/smoke-test.mjs
 */

const base = (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, "");
const key = process.env.SESSIONVAULT_API_KEY;

if (!key) {
  console.error("Set SESSIONVAULT_API_KEY=sv_live_...");
  process.exit(1);
}

const name = `smoke-${Date.now()}`;

async function mcp(method, params) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: method, arguments: params },
  };
  const res = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

const health = await fetch(`${base}/api/health`);
console.log("health", health.status, await health.json());

await mcp("save_session", {
  name,
  repo: "smoke",
  summary: "smoke test session",
  decisions: ["use neon"],
  files: [],
  todos: [],
  errors: [],
});
console.log("saved", name);

const loaded = await mcp("load_session", { name, mode: "brief" });
console.log("loaded", JSON.stringify(loaded).slice(0, 200));

await mcp("delete_session", { name });
console.log("deleted", name);
console.log("ok");
