import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakePool, fakeStore } from "./fake-neon.js";
import { authStore } from "./fake-auth-db.js";

process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";

vi.mock("@neondatabase/serverless", () => ({
  Pool: FakePool,
  neon: vi.fn(),
}));

const {
  createWebSession,
  loadWebSession,
  revokeWebSession,
  readSessionCookie,
  newSessionToken,
} = await import("../src/security/session.js");

const alice = "aaaaaaaa-1111-1111-1111-111111111111";

beforeEach(() => {
  fakeStore.reset();
  authStore.reset();
});

describe("newSessionToken", () => {
  it("returns a base64url string of sufficient length", () => {
    const t = newSessionToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(43); // 32 bytes b64url
  });

  it("is unique across calls", () => {
    const s = new Set<string>();
    for (let i = 0; i < 100; i++) s.add(newSessionToken());
    expect(s.size).toBe(100);
  });
});

describe("createWebSession / loadWebSession", () => {
  it("round-trips a valid session", async () => {
    const { token } = await createWebSession(alice, null, null);
    const s = await loadWebSession(token);
    expect(s).not.toBeNull();
    expect(s?.userId).toBe(alice);
  });

  it("returns null for an unknown token", async () => {
    const s = await loadWebSession("bogus_token_that_is_long_enough_abcd");
    expect(s).toBeNull();
  });

  it("returns null for an expired session", async () => {
    const { token } = await createWebSession(alice, null, null);
    authStore.web_sessions[0]!.expires_at = new Date(Date.now() - 1000);
    expect(await loadWebSession(token)).toBeNull();
  });

  it("returns null after revocation", async () => {
    const { token, sessionId } = await createWebSession(alice, null, null);
    await revokeWebSession(sessionId);
    expect(await loadWebSession(token)).toBeNull();
  });

  it("stores only the hash — plaintext token never appears in the DB row", async () => {
    const { token } = await createWebSession(alice, null, null);
    const row = authStore.web_sessions[0]!;
    expect(row.cookie_hash.toString("utf8")).not.toContain(token);
    expect(row.cookie_hash).toHaveLength(32); // SHA-256
  });
});

describe("readSessionCookie", () => {
  it("returns the token from a well-formed Cookie header", () => {
    const req = { headers: { cookie: "sv_session=abcdef_1234-5678_abcdef_1234-5678_abcdef" } } as never;
    expect(readSessionCookie(req)).toBe("abcdef_1234-5678_abcdef_1234-5678_abcdef");
  });

  it("returns null when cookie is absent", () => {
    expect(readSessionCookie({ headers: {} } as never)).toBeNull();
  });

  it("returns null for a cookie with a non-base64url character", () => {
    const req = { headers: { cookie: "sv_session=invalid$$$chars$$$here" } } as never;
    expect(readSessionCookie(req)).toBeNull();
  });

  it("returns null when the cookie is too short", () => {
    const req = { headers: { cookie: "sv_session=short" } } as never;
    expect(readSessionCookie(req)).toBeNull();
  });

  it("ignores other cookies and picks sv_session by name", () => {
    const req = {
      headers: {
        cookie: "theme=dark; sv_session=abcdef_1234-5678_abcdef_1234-5678_abcdef; foo=bar",
      },
    } as never;
    expect(readSessionCookie(req)).toBe(
      "abcdef_1234-5678_abcdef_1234-5678_abcdef"
    );
  });
});
