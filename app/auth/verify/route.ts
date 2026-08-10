import { NextResponse } from "next/server";
import { assertHostedConfig } from "@/src/config";
import { consumeMagicLink } from "@/src/security/magic-link";
import { generateKey, loadMasterKey, wrapKey } from "@/src/security/crypto";
import { sqlAsAdmin } from "@/src/neon/client";
import {
  createWebSession,
  firstIp,
  hashPII,
  publicBaseUrl,
  sessionCookieHeader,
} from "@/lib/web-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const base = publicBaseUrl(request);

  try {
    assertHostedConfig();
  } catch (err) {
    console.error("[auth-verify] config error:", (err as Error).message);
    return NextResponse.redirect(new URL("/login?err=invalid", base));
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token || token.length < 40 || token.length > 128) {
    return NextResponse.redirect(new URL("/login?err=invalid", base));
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    return NextResponse.redirect(new URL("/login?err=invalid", base));
  }

  const result = await consumeMagicLink(token);
  if (!result.ok) {
    return NextResponse.redirect(
      new URL(
        `/login?err=${result.reason === "expired" ? "expired" : "invalid"}`,
        base
      )
    );
  }

  const userId = await upsertUser(result.email);
  const ipHash = hashPII(firstIp(request.headers.get("x-forwarded-for")));
  const uaHash = hashPII(request.headers.get("user-agent") ?? undefined);
  const { token: sessionToken } = await createWebSession(userId, ipHash, uaHash);

  const res = NextResponse.redirect(new URL("/dashboard", base));
  res.headers.append("Set-Cookie", sessionCookieHeader(sessionToken));
  res.headers.set("Cache-Control", "no-store");
  return res;
}

async function upsertUser(email: string): Promise<string> {
  return sqlAsAdmin(async (c) => {
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1`,
      [email]
    );
    if (existing.rows[0]) return existing.rows[0].id;

    const masterKey = loadMasterKey(process.env.SESSIONVAULT_MASTER_KEY);
    const dek = generateKey();
    const { wrapped, nonce } = wrapKey(dek, masterKey);
    const inserted = await c.query<{ id: string }>(
      `INSERT INTO users (email, dek_wrapped, dek_nonce)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [email, wrapped, nonce]
    );
    return inserted.rows[0]!.id;
  });
}
