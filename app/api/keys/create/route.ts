import { NextResponse } from "next/server";
import { generateApiKey, hashApiKey, keyPrefix } from "@/src/security/api-key";
import { sqlAsAdmin } from "@/src/neon/client";
import {
  isOriginAllowed,
  publicBaseUrl,
  readFormData,
  requireWebSession,
} from "@/lib/web-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const base = publicBaseUrl(request);
  if (!isOriginAllowed(request)) {
    return NextResponse.redirect(new URL("/dashboard?err=csrf", base));
  }

  const session = await requireWebSession(request);
  if (!session) {
    return NextResponse.redirect(new URL("/login", base));
  }

  let name: string | null = null;
  try {
    const form = await readFormData(request);
    const raw = String(form.name ?? "").trim();
    if (raw.length) name = raw.slice(0, 60);
  } catch {
    /* empty name is fine */
  }

  const apiKey = generateApiKey();
  const kh = hashApiKey(apiKey);
  const kp = keyPrefix(apiKey);

  await sqlAsAdmin((c) =>
    c.query(
      `INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
       VALUES ($1, $2, $3, $4)`,
      [session.userId, kh, kp, name]
    )
  );

  return NextResponse.redirect(
    new URL(`/dashboard?created=${encodeURIComponent(apiKey)}`, base),
    { headers: { "Cache-Control": "no-store" } }
  );
}
