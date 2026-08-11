# SessionVault

Shared session memory for MCP clients. Next.js SaaS on Vercel + Neon + pgvector.

Save structured context in Claude. Load it in Cursor. Encrypted at rest, tenant-isolated, API-key gated.

## Quick start

Accounts: [Vercel](https://vercel.com), [Neon](https://neon.tech), [OpenAI](https://platform.openai.com), [Resend](https://resend.com).

```bash
pnpm install
pnpm sv:generate-keys          # copy into Vercel env / .env.local
export DATABASE_URL="postgres://...neon.../neondb?sslmode=require"
pnpm sv:setup-db
pnpm dlx vercel                # set env from .env.vercel.example
```

Required env: `DATABASE_URL`, `OPENAI_API_KEY`, `SESSIONVAULT_MASTER_KEY`, `SESSIONVAULT_AUDIT_SALT`, `PUBLIC_URL`, `RESEND_API_KEY` (required in production).

Sign in at your deployment URL, create an API key, then:

```json
{
  "mcpServers": {
    "sessionvault": {
      "url": "https://your-app.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer sv_live_..." }
    }
  }
}
```

Local UI: copy `.env.example` to `.env.local`, then `pnpm dev`.

## Tools

| Tool | Purpose |
|---|---|
| `save_session` | Upsert structured session (encrypted) |
| `load_session` | Exact name lookup |
| `search_sessions` | Semantic search (pgvector) |
| `list_sessions` | Newest first |
| `delete_session` | Delete by name |

## Architecture

- **App:** Next.js (dashboard + magic-link auth + MCP route)
- **DB:** Neon Postgres + pgvector
- **Crypto:** AES-256-GCM envelope (per-user DEK)
- **Tenancy:** Forced Postgres RLS
- **Agent auth:** Bearer `sv_live_...` (hashed at rest)

See [SECURITY.md](./SECURITY.md) and [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md).

## Scripts

| Script | Role |
|---|---|
| `pnpm dev` | Next.js local |
| `pnpm build` / `pnpm start` | Production Next build/serve |
| `pnpm test` | Unit tests |
| `pnpm sv:generate-keys` | Master key + audit salt |
| `pnpm sv:setup-db` | Apply `sql/schema.sql` |
| `pnpm sv:create-user` | Optional CLI user + key |

## License

MIT
