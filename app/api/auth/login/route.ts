import { NextResponse } from "next/server";
import { assertHostedConfig } from "@/src/config";
import {
  issueMagicLink,
  TooManyLoginsError,
} from "@/src/security/magic-link";
import { sendMagicLinkEmail } from "@/src/security/email";
import {
  firstIp,
  hashPII,
  isOriginAllowed,
  publicBaseUrl,
  readFormData,
} from "@/lib/web-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  if (!isOriginAllowed(request)) {
    return NextResponse.redirect(new URL("/login?err=invalid", publicBaseUrl(request)));
  }

  try {
    assertHostedConfig();
  } catch (err) {
    console.error("[auth-login] config error:", (err as Error).message);
    return NextResponse.redirect(new URL("/login?err=invalid", publicBaseUrl(request)));
  }

  let email = "";
  try {
    const form = await readFormData(request);
    email = String(form.email ?? "").trim().toLowerCase();
  } catch {
    return NextResponse.redirect(new URL("/login?err=email", publicBaseUrl(request)));
  }

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return NextResponse.redirect(new URL("/login?err=email", publicBaseUrl(request)));
  }

  const ipHash = hashPII(firstIp(request.headers.get("x-forwarded-for")));

  try {
    const token = await issueMagicLink(email, ipHash);
    const link = `${publicBaseUrl(request)}/auth/verify?token=${encodeURIComponent(token)}`;
    sendMagicLinkEmail(email, link).catch((err: Error) => {
      console.error(`[auth-login] email send failed: ${err.message}`);
    });
  } catch (err) {
    if (err instanceof TooManyLoginsError) {
      return NextResponse.redirect(
        new URL(
          `/login?err=rate&email=${encodeURIComponent(email)}`,
          publicBaseUrl(request)
        )
      );
    }
    console.error("[auth-login] issue failed:", (err as Error).message);
  }

  return NextResponse.redirect(new URL("/login?sent=1", publicBaseUrl(request)));
}
