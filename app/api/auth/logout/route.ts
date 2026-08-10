import { NextResponse } from "next/server";
import {
  clearSessionCookieHeader,
  isOriginAllowed,
  publicBaseUrl,
  readSessionToken,
  revokeWebSession,
  loadWebSession,
} from "@/lib/web-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const base = publicBaseUrl(request);
  if (!isOriginAllowed(request)) {
    return NextResponse.redirect(new URL("/login", base));
  }

  const token = readSessionToken(request);
  if (token) {
    const session = await loadWebSession(token);
    if (session) await revokeWebSession(session.id);
  }

  const res = NextResponse.redirect(new URL("/login", base));
  res.headers.append("Set-Cookie", clearSessionCookieHeader());
  res.headers.set("Cache-Control", "no-store");
  return res;
}
