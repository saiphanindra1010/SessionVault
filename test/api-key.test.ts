import { describe, expect, it } from "vitest";
import {
  KEY_PREFIX,
  generateApiKey,
  hashApiKey,
  keyPrefix,
  parseBearer,
} from "../src/security/api-key.js";

describe("generateApiKey", () => {
  it("has the sv_live_ prefix", () => {
    expect(generateApiKey().startsWith(KEY_PREFIX)).toBe(true);
  });

  it("is long enough to have >=128 bits of entropy", () => {
    // 24 bytes base64url ~= 32 chars + 8 char prefix = 40 chars.
    expect(generateApiKey().length).toBeGreaterThanOrEqual(35);
  });

  it("is unique across many calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateApiKey());
    expect(seen.size).toBe(200);
  });
});

describe("hashApiKey", () => {
  it("returns a 32-byte SHA-256 digest as Buffer", () => {
    const h = hashApiKey("sv_live_abc");
    expect(h).toBeInstanceOf(Buffer);
    expect(h.length).toBe(32);
  });

  it("is deterministic", () => {
    const a = hashApiKey("sv_live_abc");
    const b = hashApiKey("sv_live_abc");
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it("differs for different inputs", () => {
    const a = hashApiKey("sv_live_abc");
    const b = hashApiKey("sv_live_abd");
    expect(Buffer.compare(a, b)).not.toBe(0);
  });
});

describe("keyPrefix", () => {
  it("returns the first 12 chars", () => {
    expect(keyPrefix("sv_live_abcdefghij")).toBe("sv_live_abcd");
  });
});

describe("parseBearer", () => {
  it("extracts a valid bearer token", () => {
    const k = generateApiKey();
    expect(parseBearer(`Bearer ${k}`)).toBe(k);
  });

  it("is case-insensitive on the scheme", () => {
    const k = generateApiKey();
    expect(parseBearer(`bearer ${k}`)).toBe(k);
    expect(parseBearer(`BEARER ${k}`)).toBe(k);
  });

  it("returns null for missing", () => {
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("")).toBeNull();
  });

  it("returns null for wrong scheme", () => {
    expect(parseBearer(`Basic ${generateApiKey()}`)).toBeNull();
    expect(parseBearer(`token ${generateApiKey()}`)).toBeNull();
  });

  it("returns null for wrong prefix", () => {
    expect(parseBearer("Bearer bad_prefix_1234567890abcd")).toBeNull();
  });

  it("returns null for too-short tokens", () => {
    expect(parseBearer("Bearer sv_live_short")).toBeNull();
  });

  it("takes the first value of an array header", () => {
    const k = generateApiKey();
    expect(parseBearer([`Bearer ${k}`, "Bearer other"])).toBe(k);
  });
});
