/**
 * Per-request user context, propagated via AsyncLocalStorage.
 *
 * Rationale: the MCP tool handlers (in src/tools.ts) don't take a "user"
 * argument — they just call `saveSession`, `loadSession`, etc. We could
 * thread the user through every function, but that (a) leaks the concept
 * into the local-mode code paths that don't need it, and (b) is easy to
 * forget. AsyncLocalStorage gives us a "current user" that the Neon memory
 * impl can pick up without changing every signature.
 *
 * Safety: if a caller forgets to wrap a request in `runWithUser`, the Neon
 * memory impl will throw a clear error rather than silently query with no
 * tenant filter (which would be blocked by RLS anyway, but throwing early
 * gives us a better failure mode).
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type RequestUser = {
  id: string;
  /** Unwrapped DEK, ready for encrypt/decrypt. Zero out after request if possible. */
  dek: Buffer;
  /** Public key prefix (for audit_log), never the raw key. */
  keyPrefix: string;
};

const storage = new AsyncLocalStorage<RequestUser>();

export function runWithUser<T>(user: RequestUser, fn: () => Promise<T>): Promise<T> {
  return storage.run(user, fn);
}

/** Get the current request's user or throw. Use this in code that MUST have one. */
export function currentUser(): RequestUser {
  const u = storage.getStore();
  if (!u) {
    throw new Error(
      "No user in async context. This is a server bug: a request handler " +
        "failed to wrap execution in runWithUser()."
    );
  }
  return u;
}

/** Non-throwing variant for code that may run in both hosted and local modes. */
export function tryCurrentUser(): RequestUser | null {
  return storage.getStore() ?? null;
}
