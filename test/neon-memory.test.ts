/**
 * NeonMemoryBackend integration-lite tests:
 *   * DB layer is a FakePool that mimics RLS behavior.
 *   * Embeddings provider is a deterministic fake (hash-based) so search is
 *     reproducible.
 *   * Crypto is the REAL crypto, so this also verifies the round-trip.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakePool, fakeStore } from "./fake-neon.js";

process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";

vi.mock("@neondatabase/serverless", () => {
  return {
    Pool: vi.fn().mockImplementation(() => new FakePool()),
    neon: vi.fn(),
  };
});

// Load AFTER the mock is registered.
const { generateKey } = await import("../src/security/crypto.js");
const { runWithUser } = await import("../src/security/context.js");
const { _setEmbeddingProviderForTests } = await import(
  "../src/neon/embeddings.js"
);
const { NeonMemoryBackend } = await import("../src/memory/neon.js");

// Deterministic 1536-dim "embedding": hash the string into 1536 floats.
function fakeEmbed(text: string): number[] {
  const out = new Array<number>(1536).fill(0);
  for (let i = 0; i < text.length; i++) {
    out[i % 1536] += text.charCodeAt(i);
  }
  // normalize-ish
  const s = out.reduce((a, b) => a + b * b, 0);
  const n = Math.sqrt(s) || 1;
  return out.map((v) => v / n);
}
_setEmbeddingProviderForTests({ embed: async (t) => fakeEmbed(t) });

const backend = new NeonMemoryBackend();

const baseInput = {
  name: "cross-ai-plan",
  repo: "acme-app",
  summary: "Designed the auth flow with Claude, ready to implement in Cursor.",
  decisions: ["JWT for stateless", "1h expiry", "refresh via HttpOnly cookie"],
  todos: ["wire login route", "add rate limit"],
  files: ["src/auth.ts"],
  errors: [],
};

function withUser<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const dek = generateKey();
  return runWithUser({ id, dek, keyPrefix: "sv_live_test" }, fn);
}

const alice = "11111111-1111-1111-1111-111111111111";
const bob = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  fakeStore.reset();
});

describe("NeonMemoryBackend", () => {
  it("saves and loads a session round-trip through encryption", async () => {
    await withUser(alice, async () => {
      const save = await backend.saveSession(baseInput);
      expect(save.status).toBe("saved");
      const load = await backend.loadSession("cross-ai-plan", "normal");
      expect(load.found).toBe(true);
      if (!load.found) return;
      expect(load.session.summary).toBe(baseInput.summary);
      expect(load.session.decisions).toEqual(baseInput.decisions);
    });
  });

  it("stores CIPHERTEXT in the DB (verifies real encryption at rest)", async () => {
    await withUser(alice, async () => {
      await backend.saveSession(baseInput);
    });
    const row = fakeStore.sessions[0]!;
    const asText = row.content_ct.toString("utf8");
    // Confirm the summary text does NOT appear anywhere in the ciphertext.
    expect(asText).not.toContain("auth flow");
    expect(asText).not.toContain("JWT");
    expect(row.content_ct.length).toBeGreaterThan(16);
    expect(row.content_nonce).toHaveLength(12);
  });

  it("brief mode strips arrays", async () => {
    await withUser(alice, async () => {
      await backend.saveSession(baseInput);
      const r = await backend.loadSession("cross-ai-plan", "brief");
      expect(r.found).toBe(true);
      if (!r.found) return;
      expect(r.session.decisions).toEqual([]);
    });
  });

  it("overwrites on same-name save", async () => {
    await withUser(alice, async () => {
      await backend.saveSession(baseInput);
      await backend.saveSession({ ...baseInput, summary: "revised" });
      expect(fakeStore.sessions).toHaveLength(1);
      const r = await backend.loadSession(baseInput.name, "normal");
      expect(r.found && r.session.summary).toBe("revised");
    });
  });

  it("returns found:false for missing session (deterministic load)", async () => {
    await withUser(alice, async () => {
      const r = await backend.loadSession("nope", "normal");
      expect(r.found).toBe(false);
    });
  });

  it("tenant isolation: user B cannot see user A's session", async () => {
    await withUser(alice, async () => {
      await backend.saveSession(baseInput);
    });
    await withUser(bob, async () => {
      const r = await backend.loadSession(baseInput.name, "normal");
      expect(r.found).toBe(false);
    });
  });

  it("tenant isolation: search only returns caller's rows", async () => {
    await withUser(alice, async () => {
      await backend.saveSession({ ...baseInput, name: "alpha" });
    });
    await withUser(bob, async () => {
      await backend.saveSession({ ...baseInput, name: "beta" });
      const hits = await backend.searchMemories(baseInput.summary, 5);
      expect(hits.length).toBe(1);
      expect(hits[0]!.metadata?.session_name).toBe("beta");
    });
  });

  it("list_sessions filters by repo", async () => {
    await withUser(alice, async () => {
      await backend.saveSession({ ...baseInput, name: "a", repo: "one" });
      await backend.saveSession({ ...baseInput, name: "b", repo: "two" });
      const one = await backend.listSessions("one");
      expect(one).toHaveLength(1);
      expect(one[0]!.name).toBe("a");
    });
  });

  it("delete removes only the targeted row", async () => {
    await withUser(alice, async () => {
      await backend.saveSession({ ...baseInput, name: "keep" });
      await backend.saveSession({ ...baseInput, name: "drop" });
      const res = await backend.deleteSession("drop");
      expect(res.deleted).toBe(1);
      const keep = await backend.loadSession("keep", "brief");
      const drop = await backend.loadSession("drop", "brief");
      expect(keep.found).toBe(true);
      expect(drop.found).toBe(false);
    });
  });

  it("delete of missing session returns 0 (no throw)", async () => {
    await withUser(alice, async () => {
      const r = await backend.deleteSession("missing");
      expect(r.deleted).toBe(0);
    });
  });

  it("searchWithinBudget respects the token cap", async () => {
    await withUser(alice, async () => {
      await backend.saveSession(baseInput);
      const r = await backend.searchWithinBudget("auth", 40);
      expect(r.tokens_used).toBeLessThanOrEqual(40);
    });
  });

  it("throws with a clear message when called outside runWithUser", async () => {
    await expect(backend.saveSession(baseInput)).rejects.toThrow(/context/);
  });

  it("rejects an invalid uuid at the client layer (defense in depth)", async () => {
    const badUser = "not-a-uuid";
    const dek = generateKey();
    await expect(
      runWithUser({ id: badUser, dek, keyPrefix: "x" }, () =>
        backend.saveSession(baseInput)
      )
    ).rejects.toThrow(/uuid/i);
  });
});
