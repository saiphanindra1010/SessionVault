/**
 * Envelope encryption using AES-256-GCM.
 *
 * Why envelope encryption:
 *   - Master Key (MK) lives in an env var / KMS. Never touches the DB.
 *   - Each user has a Data Encryption Key (DEK), generated at signup.
 *   - DEK is encrypted ("wrapped") with the MK and stored in `users`.
 *   - Session content is encrypted with the DEK.
 *
 * Payoff:
 *   - Master key rotation only requires re-wrapping DEKs, not re-encrypting
 *     GBs of session content.
 *   - DB dump alone is useless: attacker also needs the MK.
 *   - Per-user DEKs bound the blast radius of a compromised DEK.
 *
 * Ciphertext layout on disk:
 *   nonce: BYTEA(12)             stored in a separate column for clarity
 *   ciphertext_and_tag: BYTEA    encrypted bytes || 16-byte GCM auth tag
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** AES-256-GCM key size. */
const KEY_LEN = 32;
/** GCM standard nonce length. NIST SP 800-38D recommends 12 bytes. */
const NONCE_LEN = 12;
/** GCM auth tag length. 16 bytes = 128 bits, the strongest option. */
const TAG_LEN = 16;

/** Randomly-generated 32-byte key, safe for AES-256-GCM. */
export function generateKey(): Buffer {
  return randomBytes(KEY_LEN);
}

/** Encrypt `plaintext` with `key` (32 bytes). Returns nonce + ciphertext||tag. */
export function encrypt(
  plaintext: Buffer | string,
  key: Buffer
): { nonce: Buffer; ciphertext: Buffer } {
  assertKey(key);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: TAG_LEN,
  });
  const buf = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce, ciphertext: Buffer.concat([enc, tag]) };
}

/**
 * Decrypt `ciphertext` (which must include the 16-byte auth tag appended by
 * `encrypt`) with `nonce` + `key`. Throws on tag mismatch — i.e. any tamper
 * with the ciphertext.
 */
export function decrypt(ciphertext: Buffer, nonce: Buffer, key: Buffer): Buffer {
  assertKey(key);
  if (nonce.length !== NONCE_LEN) throw new Error(`invalid nonce length: ${nonce.length}`);
  if (ciphertext.length < TAG_LEN) throw new Error("ciphertext too short");
  const enc = ciphertext.subarray(0, ciphertext.length - TAG_LEN);
  const tag = ciphertext.subarray(ciphertext.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
    authTagLength: TAG_LEN,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

/** Convenience: encrypt a string and return the plaintext-friendly result. */
export function encryptString(plaintext: string, key: Buffer): {
  nonce: Buffer;
  ciphertext: Buffer;
} {
  return encrypt(plaintext, key);
}

/** Convenience: decrypt to a UTF-8 string. */
export function decryptString(ciphertext: Buffer, nonce: Buffer, key: Buffer): string {
  return decrypt(ciphertext, nonce, key).toString("utf8");
}

/**
 * Wrap (encrypt) a DEK with the master key. Output is a compact
 * `{wrapped, nonce}` pair suitable for two BYTEA columns.
 */
export function wrapKey(dek: Buffer, masterKey: Buffer): {
  wrapped: Buffer;
  nonce: Buffer;
} {
  assertKey(dek);
  const { nonce, ciphertext } = encrypt(dek, masterKey);
  return { wrapped: ciphertext, nonce };
}

/** Unwrap (decrypt) a DEK previously produced by `wrapKey`. */
export function unwrapKey(wrapped: Buffer, nonce: Buffer, masterKey: Buffer): Buffer {
  const dek = decrypt(wrapped, nonce, masterKey);
  assertKey(dek);
  return dek;
}

/**
 * Decode a base64-encoded master key from an env var. Throws with a clear
 * message if the key is missing, malformed, or a well-known placeholder.
 * Called at server boot — if this throws, we do NOT want to serve requests.
 */
export function loadMasterKey(raw: string | undefined): Buffer {
  if (!raw || !raw.trim()) {
    throw new Error(
      "SESSIONVAULT_MASTER_KEY is missing. Generate one with `pnpm sv:generate-keys` " +
        "and set it in your environment before starting the server."
    );
  }
  const trimmed = raw.trim();
  if (PLACEHOLDER_MARKERS.some((m) => trimmed.includes(m))) {
    throw new Error(
      "SESSIONVAULT_MASTER_KEY still contains the example placeholder. " +
        "Generate a real key with `pnpm sv:generate-keys`."
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(trimmed, "base64");
  } catch {
    throw new Error("SESSIONVAULT_MASTER_KEY is not valid base64.");
  }
  if (buf.length !== KEY_LEN) {
    throw new Error(
      `SESSIONVAULT_MASTER_KEY must decode to ${KEY_LEN} bytes; got ${buf.length}.`
    );
  }
  return buf;
}

const PLACEHOLDER_MARKERS = ["CHANGE_ME", "REPLACE_ME", "example", "placeholder"];

function assertKey(k: Buffer): void {
  if (!Buffer.isBuffer(k) || k.length !== KEY_LEN) {
    throw new Error(`key must be a ${KEY_LEN}-byte Buffer`);
  }
}

/**
 * Compare two equal-length buffers in constant time. Wrapper that returns
 * false on length mismatch instead of throwing (a plain throw leaks the fact
 * that lengths differ, which is itself a timing side-channel).
 */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
