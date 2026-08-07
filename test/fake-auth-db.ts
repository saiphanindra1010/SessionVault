/**
 * Extra fake table state for auth tests: magic_links + web_sessions.
 * Reuses the same in-memory pattern as fake-neon.ts, hooked into the same
 * mocked Pool via a shared module.
 */
import { fakeStore, FakePool as BasePool } from "./fake-neon.js";

export type MagicRow = {
  id: number;
  email: string;
  token_hash: Buffer;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
};

export type WebSessionRow = {
  id: string;
  user_id: string;
  cookie_hash: Buffer;
  expires_at: Date;
  revoked_at: Date | null;
  ip_hash: Buffer | null;
  ua_hash: Buffer | null;
  last_used_at: Date;
};

class AuthStore {
  magic_links: MagicRow[] = [];
  web_sessions: WebSessionRow[] = [];
  next_id = 1;
  reset() {
    this.magic_links = [];
    this.web_sessions = [];
    this.next_id = 1;
  }
}

export const authStore = new AuthStore();

// Patch execute to handle our new tables. We wrap the existing store's
// execute() and intercept auth-related SQL, delegating everything else.
const originalExecute = (fakeStore as unknown as {
  execute: (sql: string, params: unknown[], activeUser: string | null) => Promise<{ rows: unknown[]; rowCount: number }>;
}).execute.bind(fakeStore);

(fakeStore as unknown as { execute: typeof originalExecute }).execute = async function (
  sql: string,
  params: unknown[],
  activeUser: string | null
) {
  const S = sql.trim();

  // ---- magic_links ------------------------------------------------------
  if (/^SELECT COUNT\(\*\) AS N\s+FROM MAGIC_LINKS/i.test(S)) {
    const [email] = params as [string];
    const cutoff = Date.now() - 3600_000;
    const n = authStore.magic_links.filter(
      (m) => m.email === email && m.created_at.getTime() > cutoff
    ).length;
    return { rows: [{ n: String(n) }], rowCount: 1 };
  }
  if (/^INSERT INTO MAGIC_LINKS/i.test(S)) {
    const [email, token_hash, expires_at] = params as [string, Buffer, Date];
    authStore.magic_links.push({
      id: authStore.next_id++,
      email,
      token_hash,
      expires_at,
      consumed_at: null,
      created_at: new Date(),
    });
    return { rows: [], rowCount: 1 };
  }
  if (/^SELECT ID, EMAIL, EXPIRES_AT, CONSUMED_AT\s+FROM MAGIC_LINKS/i.test(S)) {
    const [hash] = params as [Buffer];
    const row = authStore.magic_links.find(
      (m) => Buffer.compare(m.token_hash, hash) === 0
    );
    return row
      ? {
          rows: [
            {
              id: row.id,
              email: row.email,
              expires_at: row.expires_at,
              consumed_at: row.consumed_at,
            },
          ],
          rowCount: 1,
        }
      : { rows: [], rowCount: 0 };
  }
  if (/^UPDATE MAGIC_LINKS SET CONSUMED_AT/i.test(S)) {
    const [id] = params as [number];
    const row = authStore.magic_links.find((m) => m.id === id);
    if (row) row.consumed_at = new Date();
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  if (/^DELETE FROM MAGIC_LINKS/i.test(S)) {
    return { rows: [], rowCount: 0 };
  }

  // ---- web_sessions -----------------------------------------------------
  if (/^INSERT INTO WEB_SESSIONS/i.test(S)) {
    const [user_id, cookie_hash, expires_at, ip_hash, ua_hash] = params as [
      string,
      Buffer,
      Date,
      Buffer | null,
      Buffer | null,
    ];
    const id = `${authStore.next_id++}-11-11-1111-111111111111`.padStart(36, "a");
    const uuid = `${id.slice(0, 8)}-1111-1111-1111-111111111111`;
    const row: WebSessionRow = {
      id: uuid,
      user_id,
      cookie_hash,
      expires_at,
      revoked_at: null,
      ip_hash,
      ua_hash,
      last_used_at: new Date(),
    };
    authStore.web_sessions.push(row);
    return { rows: [{ id: uuid }], rowCount: 1 };
  }
  if (/^SELECT ID, USER_ID, EXPIRES_AT, REVOKED_AT\s+FROM WEB_SESSIONS/i.test(S)) {
    const [hash] = params as [Buffer];
    const row = authStore.web_sessions.find(
      (s) => Buffer.compare(s.cookie_hash, hash) === 0
    );
    return row
      ? {
          rows: [
            {
              id: row.id,
              user_id: row.user_id,
              expires_at: row.expires_at,
              revoked_at: row.revoked_at,
            },
          ],
          rowCount: 1,
        }
      : { rows: [], rowCount: 0 };
  }
  if (/^UPDATE WEB_SESSIONS SET LAST_USED_AT/i.test(S)) {
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE WEB_SESSIONS SET REVOKED_AT/i.test(S)) {
    const [id] = params as [string];
    const row = authStore.web_sessions.find((s) => s.id === id);
    if (row) row.revoked_at = new Date();
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  return originalExecute(sql, params, activeUser);
};

export { BasePool as FakePool };
