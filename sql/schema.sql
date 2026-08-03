-- SessionVault schema for Neon Postgres (or any Postgres 15+ with pgvector).
--
-- Security model:
--   * All user-scoped tables have Row Level Security (RLS) enabled AND FORCED.
--     "Forced" means even the table owner can't bypass RLS, so a bug in app
--     code that forgets to SET app.user_id returns zero rows instead of
--     leaking data across tenants.
--   * app.user_id is set per-transaction via `SELECT set_config('app.user_id', $1, true)`
--     before any user-scoped query.
--   * session.content is application-layer encrypted (AES-256-GCM) before it
--     ever reaches the DB. Embeddings are NOT encrypted so semantic search
--     can still work (embeddings leak far less than plaintext).
--
-- Run once:   psql "$DATABASE_URL" -f sql/schema.sql
-- Or use:    pnpm sv:setup-db

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ---------------------------------------------------------------------------
-- users: one row per API consumer.
-- dek_wrapped/dek_nonce = per-user Data Encryption Key, encrypted with the
-- server's master key (envelope encryption). This means rotating the master
-- key later doesn't require re-encrypting session content, only the DEKs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text UNIQUE,
  display_name text,
  dek_wrapped  bytea NOT NULL,
  dek_nonce    bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  disabled_at  timestamptz
);

-- ---------------------------------------------------------------------------
-- api_keys: hashed bearer tokens. We store SHA-256(key) so a DB dump does not
-- leak usable credentials. `key_prefix` is the plaintext first 12 chars so
-- users can identify keys in a future dashboard without revealing the secret.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash     bytea NOT NULL UNIQUE,   -- SHA-256(plaintext key)
  key_prefix   text  NOT NULL,          -- e.g. "sv_live_a1b2"
  name         text,                    -- optional label ("laptop", "ci")
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys(user_id);

-- ---------------------------------------------------------------------------
-- sessions: the actual data. content is encrypted; embedding is not.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             text NOT NULL,
  repo             text NOT NULL DEFAULT '',
  content_ct       bytea NOT NULL,   -- AES-256-GCM(ciphertext || auth_tag)
  content_nonce    bytea NOT NULL,   -- 12-byte GCM nonce
  content_preview  text NOT NULL DEFAULT '',   -- first ~120 chars of summary, plaintext, for list_sessions
  embedding        vector(1536),     -- OpenAI text-embedding-3-small dims. Null-safe: search skips rows without embeddings.
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- non-secret metadata only (repo, savedAt, dims)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS sessions_user_idx  ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_repo_idx  ON sessions(user_id, repo);
-- HNSW is faster + more accurate than IVFFlat for our size range.
-- ops class must match the distance we query with (cosine).
CREATE INDEX IF NOT EXISTS sessions_embedding_idx
  ON sessions USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- rate_limits: sliding-window request log per user. We keep only recent rows
-- (older than the widest window) and prune on write.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  id       bigserial PRIMARY KEY,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_limits_user_ts_idx ON rate_limits(user_id, ts DESC);

-- ---------------------------------------------------------------------------
-- audit_log: forensic trail. No plaintext IPs or user agents; we store hashes
-- so we can correlate abuse without keeping PII.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool          text NOT NULL,
  session_name  text,
  status        text NOT NULL,             -- 'ok' | 'error' | 'denied'
  ip_hash       bytea,                     -- SHA-256(ip + audit_salt)
  ua_hash       bytea,                     -- SHA-256(user_agent + audit_salt)
  err_class     text,                      -- short class ("auth", "rate_limit"), never full message
  latency_ms    integer,
  ts            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_user_ts_idx ON audit_log(user_id, ts DESC);

-- ---------------------------------------------------------------------------
-- magic_links: single-use email login tokens for the web dashboard.
-- token_hash = SHA-256(plaintext token). Plaintext lives only in the emailed
-- URL and is never persisted. consumed_at marks a token as spent so it can't
-- be replayed. We keep consumed rows briefly for the audit trail.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS magic_links (
  id           bigserial PRIMARY KEY,
  email        text NOT NULL,
  token_hash   bytea NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  ip_hash      bytea,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS magic_links_email_created_idx
  ON magic_links(email, created_at DESC);
CREATE INDEX IF NOT EXISTS magic_links_expires_idx
  ON magic_links(expires_at);

-- ---------------------------------------------------------------------------
-- web_sessions: cookie-based sessions for the dashboard UI. Distinct from
-- api_keys (which are for MCP clients) and distinct from the `sessions` table
-- (which holds user data). Sessions are revocable by DB update, which is why
-- we don't use JWTs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS web_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cookie_hash  bytea NOT NULL UNIQUE,   -- SHA-256(plaintext session token)
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip_hash      bytea,
  ua_hash      bytea,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS web_sessions_user_idx ON web_sessions(user_id);
CREATE INDEX IF NOT EXISTS web_sessions_expires_idx ON web_sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Row Level Security. Enable AND force so the table owner is subject to it too.
-- ---------------------------------------------------------------------------
ALTER TABLE sessions     ENABLE  ROW LEVEL SECURITY;
ALTER TABLE sessions     FORCE   ROW LEVEL SECURITY;
ALTER TABLE audit_log    ENABLE  ROW LEVEL SECURITY;
ALTER TABLE audit_log    FORCE   ROW LEVEL SECURITY;
ALTER TABLE rate_limits  ENABLE  ROW LEVEL SECURITY;
ALTER TABLE rate_limits  FORCE   ROW LEVEL SECURITY;

-- Helper: returns the current tenant id as uuid, or NULL if unset.
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- Drop-and-recreate so re-running the migration is idempotent.
DROP POLICY IF EXISTS sessions_tenant     ON sessions;
DROP POLICY IF EXISTS audit_tenant        ON audit_log;
DROP POLICY IF EXISTS rate_limits_tenant  ON rate_limits;

CREATE POLICY sessions_tenant ON sessions
  USING     (user_id = app_current_user_id())
  WITH CHECK(user_id = app_current_user_id());

CREATE POLICY audit_tenant ON audit_log
  USING     (user_id = app_current_user_id())
  WITH CHECK(user_id = app_current_user_id());

CREATE POLICY rate_limits_tenant ON rate_limits
  USING     (user_id = app_current_user_id())
  WITH CHECK(user_id = app_current_user_id());

-- Bookkeeping: users and api_keys are NOT tenant-scoped (they're the
-- identity system itself). Access to them must go through server code paths
-- that validate the caller (e.g. the CLI `sv:create-user`, or an internal
-- admin function). We deliberately do not expose these to MCP tools.

COMMIT;

-- Verify the extension version once:
--   SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector','pgcrypto');
