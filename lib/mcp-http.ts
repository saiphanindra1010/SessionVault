/**
 * Hosted MCP over Streamable HTTP for Next.js App Router.
 * Same auth / rate-limit / audit path as the legacy Vercel Node handler.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools } from "@/src/tools";
import { assertHostedConfig } from "@/src/config";
import { runWithUser } from "@/src/security/context";
import { authenticate, AuthError } from "@/src/security/authenticate";
import { checkRateLimit } from "@/src/security/rate-limit";
import { writeAudit } from "@/src/security/audit";
import { firstIp } from "@/lib/web-auth";

const MAX_BODY_BYTES = 1_000_000;
const PROD =
  process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";

const MCP_SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Access-Control-Allow-Origin": "null",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-SessionVault-Version": "2.0.0",
};

let configChecked = false;
function ensureConfig(): void {
  if (configChecked) return;
  assertHostedConfig();
  configChecked = true;
}

function withHeaders(res: Response, extra?: HeadersInit): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(MCP_SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  if (extra) {
    const e = new Headers(extra);
    e.forEach((v, k) => headers.set(k, v));
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function json(status: number, body: unknown, extra?: HeadersInit): Response {
  return withHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...(extra as Record<string, string>) },
    })
  );
}

export async function handleMcpRequest(request: Request): Promise<Response> {
  const start = Date.now();

  if (request.method === "OPTIONS") {
    return withHeaders(
      new Response(null, { status: 405, headers: { Allow: "GET, POST, DELETE" } })
    );
  }
  if (
    request.method !== "POST" &&
    request.method !== "GET" &&
    request.method !== "DELETE"
  ) {
    return withHeaders(
      new Response(null, { status: 405, headers: { Allow: "GET, POST, DELETE" } })
    );
  }
  if (PROD && request.headers.get("x-forwarded-proto") === "http") {
    return json(403, { error: "HTTPS required" });
  }

  try {
    ensureConfig();
  } catch (err) {
    return json(500, {
      error: "server misconfigured",
      detail: (err as Error).message,
    });
  }

  let parsedBody: unknown = undefined;
  if (request.method === "POST") {
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_BODY_BYTES) {
      return json(413, { error: "payload too large" });
    }
    if (raw.byteLength > 0) {
      try {
        parsedBody = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return json(400, { error: "bad JSON" });
      }
    }
  }

  let user;
  try {
    user = await authenticate(request.headers.get("authorization") ?? undefined);
  } catch (err) {
    const reason = err instanceof AuthError ? err.reason : "unknown";
    console.warn(`[auth] denied: reason=${reason}`);
    return json(401, { error: "unauthorized" }, {
      "WWW-Authenticate": 'Bearer realm="SessionVault"',
    });
  }

  try {
    const decision = await checkRateLimit(user.id);
    if (!decision.allowed) {
      writeAudit({
        userId: user.id,
        tool: "-",
        status: "denied",
        errClass: `rate_limit_${decision.window}`,
        ip: firstIp(request.headers.get("x-forwarded-for")),
        userAgent: request.headers.get("user-agent") ?? undefined,
        latencyMs: Date.now() - start,
      });
      return json(
        429,
        {
          error: "rate limited",
          retry_after_seconds: decision.retryAfterSeconds,
          window: decision.window,
        },
        { "Retry-After": String(decision.retryAfterSeconds) }
      );
    }
  } catch {
    return json(503, { error: "rate-limit backend unavailable" });
  }

  try {
    const response = await runWithUser(user, async () => {
      const server = new McpServer(
        { name: "sessionvault", version: "2.0.0" },
        {
          instructions:
            "SessionVault (hosted): save/load/search structured session context. Content encrypted at rest; tenant-isolated via Postgres RLS.",
        }
      );
      registerTools(server);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);

      // Rebuild Request with already-parsed body for the web transport.
      const mcpReq =
        request.method === "POST"
          ? new Request(request.url, {
              method: request.method,
              headers: request.headers,
              body:
                parsedBody === undefined
                  ? undefined
                  : JSON.stringify(parsedBody),
            })
          : request;

      return transport.handleRequest(mcpReq, {
        parsedBody,
      });
    });

    writeAudit({
      userId: user.id,
      tool: "http_request",
      status: "ok",
      ip: firstIp(request.headers.get("x-forwarded-for")),
      userAgent: request.headers.get("user-agent") ?? undefined,
      latencyMs: Date.now() - start,
    });

    return withHeaders(response);
  } catch (err) {
    console.error(`[mcp] error: ${(err as Error).message}`);
    writeAudit({
      userId: user.id,
      tool: "http_request",
      status: "error",
      errClass: classify(err),
      ip: firstIp(request.headers.get("x-forwarded-for")),
      userAgent: request.headers.get("user-agent") ?? undefined,
      latencyMs: Date.now() - start,
    });
    return json(500, { error: "internal error" });
  }
}

function classify(err: unknown): string {
  const m = (err as Error)?.message ?? String(err);
  if (/timeout/i.test(m)) return "timeout";
  if (/rate/i.test(m)) return "rate_limit";
  if (/auth/i.test(m)) return "auth";
  if (/database|postgres|neon/i.test(m)) return "db";
  if (/openai|embedding/i.test(m)) return "provider";
  return "unknown";
}
