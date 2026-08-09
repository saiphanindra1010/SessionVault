import Link from "next/link";

export default function HomePage() {
  return (
    <div className="shell">
      <nav className="site-nav">
        <Link href="/" className="brand">
          Session<span>Vault</span>
        </Link>
        <div className="nav-links">
          <Link href="/login">Sign in</Link>
        </div>
      </nav>

      <header className="hero">
        <h1>SessionVault</h1>
        <p>
          Shared session memory for MCP clients. Save in one tool, load in
          another.
        </p>
        <div className="hero-cta">
          <Link href="/login" className="btn">
            Get an API key
          </Link>
        </div>
      </header>

      <section className="section">
        <h2>Workflow</h2>
        <div className="flow panel">
          <div>
            <b>Claude</b> save_session(&quot;auth-jwt-v1&quot;)
          </div>
          <div>
            <b>Cursor</b> load_session(&quot;auth-jwt-v1&quot;)
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Clients</h2>
        <div className="integrations">
          <div className="integration">
            <h3>Claude Desktop</h3>
            <p>Remote MCP with bearer auth.</p>
          </div>
          <div className="integration">
            <h3>Cursor</h3>
            <p>Same config in mcp.json.</p>
          </div>
          <div className="integration">
            <h3>VS Code</h3>
            <p>Any MCP-capable extension.</p>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Config</h2>
        <p>
          Create a key in the dashboard, paste into the client. Content is
          encrypted at rest; tenants are isolated with Postgres RLS.
        </p>
        <pre>{`{
  "mcpServers": {
    "sessionvault": {
      "url": "https://your-app.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer sv_live_..." }
    }
  }
}`}</pre>
      </section>

      <footer className="footer">SessionVault</footer>
    </div>
  );
}
