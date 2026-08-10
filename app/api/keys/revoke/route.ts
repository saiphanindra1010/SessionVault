import { NextResponse } from "next/server";
import { sqlAsAdmin } from "@/src/neon/client";
import {
  isOriginAllowed,
  publicBaseUrl,
  readFormData,
  requireWebSession,
} from "@/lib/web-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const base = publicBaseUrl(request);
  if (!isOriginAllowed(request)) {
    return NextResponse.redirect(new URL("/dashboard?err=csrf", base));
  }

  const session = await requireWebSession(request);
  if (!session) {
    return NextResponse.redirect(new URL("/login", base));
  }

  let keyId = "";
  try {
    const form = await readFormData(request);
    keyId = String(form.key_id ?? "").trim();
  } catch {
    return NextResponse.redirect(new URL("/dashboard?err=revoke_failed", base));
  }

  if (!UUID_RE.test(keyId)) {
    return NextResponse.redirect(new URL("/dashboard?err=revoke_failed", base));
  }

  const result = await sqlAsAdmin((c) =>
    c.query(
      `UPDATE api_keys
          SET revoked_at = now()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [keyId, session.userId]
    )
  );

  if (!result.rowCount) {
    return NextResponse.redirect(new URL("/dashboard?err=revoke_failed", base));
  }

  return NextResponse.redirect(new URL("/dashboard?revoked=1", base));
}
