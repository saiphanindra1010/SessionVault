/**
 * Production backend: Neon + OpenAI embeddings + envelope encryption.
 */

import { NeonMemoryBackend } from "./neon.js";
import type { MemoryBackend } from "./types.js";

let instance: MemoryBackend | null = null;

export function getBackend(): MemoryBackend {
  if (!instance) instance = new NeonMemoryBackend();
  return instance;
}

/** Test hook. */
export function _setBackendForTests(b: MemoryBackend | null): void {
  instance = b;
}
