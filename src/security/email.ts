/**
 * Email sender.
 *
 * Uses Resend if RESEND_API_KEY is present; falls back to console.log in dev
 * so magic links still work without an email account.
 *
 * We deliberately do not include HTML rich content in login emails to keep
 * them boring, predictable, and less likely to be marked as spam.
 */

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 6_000;

export async function sendMagicLinkEmail(
  to: string,
  link: string
): Promise<void> {
  const from = process.env.SESSIONVAULT_EMAIL_FROM || "onboarding@resend.dev";
  const apiKey = process.env.RESEND_API_KEY;

  const subject = "Your SessionVault login link";
  const text =
    `Click the link below to sign in to SessionVault. It expires in 15 minutes.\n\n` +
    `    ${link}\n\n` +
    `If you did not request this, ignore this email — your account is unchanged.\n`;

  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.log(
      `\n[email:dev-fallback] would send login link to ${to}:\n    ${link}\n`
    );
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ from, to, subject, text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Don't leak the API key or full body; short prefix is enough for ops.
      throw new Error(`resend ${res.status}: ${body.slice(0, 120)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
