/**
 * In-memory fake for the @neondatabase/serverless Pool.
 *
 * Enough surface to run NeonMemoryBackend end-to-end without a real DB.
 * Enforces one important invariant we care about in tests: every user-scoped
 * query must run in a transaction that first called set_config('app.user_id',...).
 * If a test path skips it, our fake returns zero rows (mirroring RLS).
 */

type Row = Record<string, unknown>;

type QueryResult = { rows: Row[]; rowCount: number };

class FakeClient {
  private activeUser: string | null = null;
  private inTx = false;
  released = false;

  constructor(private readonly store: Store) {}

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const t = sql.trim().toUpperCase();
    if (t.startsWith("BEGIN")) {
      this.inTx = true;
      this.activeUser = null;
      return empty();
    }
    if (t.startsWith("COMMIT") || t.startsWith("ROLLBACK")) {
      this.inTx = false;
      this.activeUser = null;
      return empty();
    }
    if (/SELECT SET_CONFIG\('APP\.USER_ID'/i.test(sql)) {
      this.activeUser = String(params[0]);
      return empty();
    }

    // Enforce RLS-in-spirit: user-scoped queries need active user.
    if (/FROM SESSIONS|INTO SESSIONS|UPDATE SESSIONS|DELETE FROM SESSIONS/i.test(sql)) {
      if (!this.activeUser) return { rows: [], rowCount: 0 };
    }
    if (/FROM RATE_LIMITS|INTO RATE_LIMITS|DELETE FROM RATE_LIMITS/i.test(sql)) {
      if (!this.activeUser) return { rows: [], rowCount: 0 };
    }

    return this.store.execute(sql, params, this.activeUser);
  }

  release() {
    this.released = true;
  }
}

class Store {
  sessions: Array<{
    user_id: string;
    name: string;
    repo: string;
    content_ct: Buffer;
    content_nonce: Buffer;
    content_preview: string;
    embedding: number[] | null;
    metadata: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
  }> = [];
  rate_limits: Array<{ user_id: string; ts: Date }> = [];
  users: Array<{
    id: string;
    email: string | null;
    dek_wrapped: Buffer;
    dek_nonce: Buffer;
    disabled_at: Date | null;
  }> = [];
  api_keys: Array<{
    key_hash: Buffer;
    key_prefix: string;
    user_id: string;
    revoked_at: Date | null;
  }> = [];

  reset() {
    this.sessions = [];
    this.rate_limits = [];
    this.users = [];
    this.api_keys = [];
  }

  async execute(sql: string, params: unknown[], activeUser: string | null): Promise<QueryResult> {
    const S = sql.trim();

    // ---- sessions ---------------------------------------------------------
    if (/^INSERT INTO SESSIONS/i.test(S)) {
      const [
        user_id,
        name,
        repo,
        content_ct,
        content_nonce,
        content_preview,
        embedding,
        metadata,
      ] = params as [string, string, string, Buffer, Buffer, string, string | null, string];
      const existing = this.sessions.find(
        (r) => r.user_id === user_id && r.name === name
      );
      const row = {
        user_id,
        name,
        repo,
        content_ct,
        content_nonce,
        content_preview,
        embedding: embedding ? parseVectorLit(embedding) : null,
        metadata: JSON.parse(metadata),
        created_at: existing?.created_at ?? new Date(),
        updated_at: new Date(),
      };
      if (existing) Object.assign(existing, row);
      else this.sessions.push(row);
      return { rows: [], rowCount: 1 };
    }

    if (/^SELECT CONTENT_CT, CONTENT_NONCE/i.test(S)) {
      const [uid, name] = params as [string, string];
      const row = this.sessions.find((r) => r.user_id === uid && r.name === name && r.user_id === activeUser);
      return row ? { rows: [{ content_ct: row.content_ct, content_nonce: row.content_nonce }], rowCount: 1 } : empty();
    }

    if (/^DELETE FROM SESSIONS/i.test(S)) {
      const [uid, name] = params as [string, string];
      const before = this.sessions.length;
      this.sessions = this.sessions.filter(
        (r) => !(r.user_id === uid && r.name === name && r.user_id === activeUser)
      );
      return { rows: [], rowCount: before - this.sessions.length };
    }

    if (/^SELECT NAME, REPO, CONTENT_PREVIEW/i.test(S)) {
      const [uid, maybeRepo] = params as [string, string | undefined];
      const list = this.sessions
        .filter((r) => r.user_id === uid && r.user_id === activeUser)
        .filter((r) => !maybeRepo || r.repo === maybeRepo)
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
        .map((r) => ({
          name: r.name,
          repo: r.repo,
          content_preview: r.content_preview,
          created_at: r.created_at,
          updated_at: r.updated_at,
        }));
      return { rows: list, rowCount: list.length };
    }

    if (/embedding <=> \$1::vector/i.test(S)) {
      // simulate cosine distance: 1 - dotProduct/(||a||*||b||); we'll use a naive scoring
      const q = parseVectorLit(String(params[0]));
      const uid = String(params[1]);
      const maybeRepo = params.length === 4 ? String(params[2]) : undefined;
      const limit = Number(params[params.length - 1]);
      const rows = this.sessions
        .filter((r) => r.user_id === uid && r.user_id === activeUser && r.embedding)
        .filter((r) => !maybeRepo || r.repo === maybeRepo)
        .map((r) => ({
          name: r.name,
          repo: r.repo,
          content_ct: r.content_ct,
          content_nonce: r.content_nonce,
          distance: cosineDistance(q, r.embedding!),
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }

    // ---- rate_limits ------------------------------------------------------
    if (/^DELETE FROM RATE_LIMITS/i.test(S)) {
      const [uid] = params as [string];
      const cutoff = Date.now() - 24 * 3600 * 1000;
      const before = this.rate_limits.length;
      this.rate_limits = this.rate_limits.filter(
        (r) => !(r.user_id === uid && r.user_id === activeUser && r.ts.getTime() < cutoff)
      );
      return { rows: [], rowCount: before - this.rate_limits.length };
    }

    if (/COUNT\(\*\) FILTER \(WHERE TS/i.test(S)) {
      const [uid] = params as [string];
      const now = Date.now();
      const rows = this.rate_limits.filter((r) => r.user_id === uid && r.user_id === activeUser);
      return {
        rows: [
          {
            minute_count: String(rows.filter((r) => r.ts.getTime() > now - 60_000).length),
            day_count: String(rows.length),
          },
        ],
        rowCount: 1,
      };
    }

    if (/^INSERT INTO RATE_LIMITS/i.test(S)) {
      const [uid] = params as [string];
      this.rate_limits.push({ user_id: uid, ts: new Date() });
      return { rows: [], rowCount: 1 };
    }

    // ---- users / api_keys (admin path, no RLS enforcement) ---------------
    if (/^SELECT K\.USER_ID, K\.KEY_PREFIX/i.test(S)) {
      const [hash] = params as [Buffer];
      const k = this.api_keys.find((x) => Buffer.compare(x.key_hash, hash) === 0);
      if (!k) return empty();
      const u = this.users.find((x) => x.id === k.user_id);
      if (!u) return empty();
      return {
        rows: [
          {
            user_id: u.id,
            key_prefix: k.key_prefix,
            revoked_at: k.revoked_at,
            disabled_at: u.disabled_at,
            dek_wrapped: u.dek_wrapped,
            dek_nonce: u.dek_nonce,
          },
        ],
        rowCount: 1,
      };
    }

    if (/^UPDATE API_KEYS SET LAST_USED_AT/i.test(S)) {
      return { rows: [], rowCount: 1 };
    }

    return empty();
  }
}

function empty(): QueryResult {
  return { rows: [], rowCount: 0 };
}
function parseVectorLit(s: string): number[] {
  return s
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((n) => Number(n));
}
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  const cos = dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
  return 1 - cos;
}

export const fakeStore = new Store();

export class FakePool {
  async connect(): Promise<FakeClient> {
    return new FakeClient(fakeStore);
  }
  async end(): Promise<void> {
    /* no-op */
  }
}
