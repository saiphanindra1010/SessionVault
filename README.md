# SessionVault

Two parts:

1. **App** (Next.js on Vercel) — sign in, API keys, MCP endpoint  
2. **Site** (`site/`, GitHub Pages) — integration docs, no signup

## App (Vercel)

```bash
npm install
npm run sv:generate-keys
export DATABASE_URL="postgres://...neon.../neondb?sslmode=require"
npm run sv:setup-db
npx vercel
```

Set env from `.env.vercel.example`. App root redirects to `/login`.

MCP config after you create a key:

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

## Site (GitHub Pages)

Static HTML in `site/`. Edit `site/config.js`:

```js
APP_URL: "https://your-app.vercel.app",
GITHUB_URL: "https://github.com/saiphanindra1010/sessionvault",
```

Enable Pages: repo Settings → Pages → Source = GitHub Actions.  
Push to `main` runs `.github/workflows/pages.yml`.

## Scripts

| Script | Role |
|---|---|
| `npm run dev` | Next app locally |
| `npm run build` / `npm start` | Production app |
| `npm test` | Unit tests |
| `npm run sv:generate-keys` | Master key + audit salt |
| `npm run sv:setup-db` | Apply schema |

## License

MIT
