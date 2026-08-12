import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakePool, fakeStore } from "./fake-neon.js";
import { authStore } from "./fake-auth-db.js";

process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";

vi.mock("@neondatabase/serverless", () => ({
  Pool: FakePool,
  neon: vi.fn(),
}));

const { issueMagicLink, consumeMagicLink, TooManyLoginsError } = await import(
  "../src/security/magic-link.js"
);

beforeEach(() => {
  fakeStore.reset();
  authStore.reset();
});

describe("issueMagicLink", () => {
  it("returns a base64url token with plausible length", async () => {
    const t = await issueMagicLink("user@example.com", null);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(40);
  });

  it("normalizes email to lowercase for storage", async () => {
    await issueMagicLink("USER@Example.com", null);
    expect(authStore.magic_links[0]!.email).toBe("user@example.com");
  });

  it("throws TooManyLoginsError after 5 requests in an hour", async () => {
    for (let i = 0; i < 5; i++) {
      await issueMagicLink("spammy@example.com", null);
    }
    await expect(issueMagicLink("spammy@example.com", null)).rejects.toThrow(
      TooManyLoginsError
    );
  });

  it("rate limit is per-email (other users unaffected)", async () => {
    for (let i = 0; i < 5; i++) await issueMagicLink("a@example.com", null);
    // Other user still fine.
    await expect(issueMagicLink("b@example.com", null)).resolves.toBeTruthy();
  });
});

describe("consumeMagicLink", () => {
  it("consumes a valid token exactly once", async () => {
    const t = await issueMagicLink("u@example.com", null);
    const r1 = await consumeMagicLink(t);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.email).toBe("u@example.com");
    const r2 = await consumeMagicLink(t);
    expect(r2).toEqual({ ok: false, reason: "consumed" });
  });

  it("returns not_found for a made-up token", async () => {
    const r = await consumeMagicLink("nonexistent_token_that_is_long_enough_1234");
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns expired for a token past its ttl", async () => {
    const t = await issueMagicLink("u@example.com", null);
    // Force expiry.
    authStore.magic_links[0]!.expires_at = new Date(Date.now() - 1000);
    const r = await consumeMagicLink(t);
    expect(r).toEqual({ ok: false, reason: "expired" });
  });

  it("consumed_at is set after successful consume", async () => {
    const t = await issueMagicLink("u@example.com", null);
    await consumeMagicLink(t);
    expect(authStore.magic_links[0]!.consumed_at).not.toBeNull();
  });
});
