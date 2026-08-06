import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decrypt,
  decryptString,
  encrypt,
  encryptString,
  generateKey,
  loadMasterKey,
  safeEqual,
  unwrapKey,
  wrapKey,
} from "../src/security/crypto.js";

describe("AES-256-GCM encrypt/decrypt", () => {
  it("round-trips a string", () => {
    const k = generateKey();
    const { nonce, ciphertext } = encryptString("hello world", k);
    expect(decryptString(ciphertext, nonce, k)).toBe("hello world");
  });

  it("produces different nonces for identical plaintext", () => {
    const k = generateKey();
    const a = encrypt("same", k);
    const b = encrypt("same", k);
    expect(Buffer.compare(a.nonce, b.nonce)).not.toBe(0);
    expect(Buffer.compare(a.ciphertext, b.ciphertext)).not.toBe(0);
  });

  it("throws on tampered ciphertext (auth tag mismatch)", () => {
    const k = generateKey();
    const { nonce, ciphertext } = encryptString("secret", k);
    ciphertext[0] = ciphertext[0]! ^ 0xff;
    expect(() => decryptString(ciphertext, nonce, k)).toThrow();
  });

  it("throws on tampered nonce", () => {
    const k = generateKey();
    const { nonce, ciphertext } = encryptString("secret", k);
    nonce[0] = nonce[0]! ^ 0xff;
    expect(() => decryptString(ciphertext, nonce, k)).toThrow();
  });

  it("rejects the wrong key", () => {
    const { nonce, ciphertext } = encryptString("secret", generateKey());
    expect(() => decryptString(ciphertext, nonce, generateKey())).toThrow();
  });

  it("rejects keys of wrong length", () => {
    expect(() => encrypt("x", Buffer.alloc(16))).toThrow(/32-byte/);
    expect(() => encrypt("x", Buffer.alloc(64))).toThrow(/32-byte/);
  });

  it("rejects nonces of wrong length", () => {
    const k = generateKey();
    const { ciphertext } = encryptString("x", k);
    expect(() => decrypt(ciphertext, Buffer.alloc(8), k)).toThrow(/nonce/);
  });
});

describe("envelope wrap / unwrap", () => {
  it("round-trips a DEK under a master key", () => {
    const mk = generateKey();
    const dek = generateKey();
    const { wrapped, nonce } = wrapKey(dek, mk);
    const unwrapped = unwrapKey(wrapped, nonce, mk);
    expect(Buffer.compare(dek, unwrapped)).toBe(0);
  });

  it("unwrapping with wrong master key fails cleanly", () => {
    const dek = generateKey();
    const { wrapped, nonce } = wrapKey(dek, generateKey());
    expect(() => unwrapKey(wrapped, nonce, generateKey())).toThrow();
  });
});

describe("loadMasterKey", () => {
  it("accepts a valid 32-byte base64 key", () => {
    const raw = randomBytes(32).toString("base64");
    expect(loadMasterKey(raw)).toHaveLength(32);
  });

  it("rejects missing", () => {
    expect(() => loadMasterKey(undefined)).toThrow(/missing/i);
    expect(() => loadMasterKey("")).toThrow(/missing/i);
    expect(() => loadMasterKey("   ")).toThrow(/missing/i);
  });

  it("rejects placeholder values", () => {
    expect(() => loadMasterKey("CHANGE_ME_run_pnpm_sv_generate_keys")).toThrow(
      /placeholder/i
    );
    expect(() => loadMasterKey("REPLACE_ME_now")).toThrow(/placeholder/i);
  });

  it("rejects wrong length after decode", () => {
    expect(() => loadMasterKey(Buffer.alloc(16).toString("base64"))).toThrow(
      /32 bytes/i
    );
  });
});

describe("safeEqual", () => {
  it("returns true for equal buffers", () => {
    const a = Buffer.from("abcdef");
    const b = Buffer.from("abcdef");
    expect(safeEqual(a, b)).toBe(true);
  });
  it("returns false for different buffers of same length", () => {
    expect(safeEqual(Buffer.from("abcdef"), Buffer.from("abcdez"))).toBe(false);
  });
  it("returns false (never throws) for different lengths", () => {
    expect(safeEqual(Buffer.from("abc"), Buffer.from("abcdef"))).toBe(false);
  });
});
