import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sqlAsAdmin } from "@/src/neon/client";
import { COOKIE_NAME, loadWebSession } from "@/lib/web-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type KeyRow = {
  id: string;
  key_prefix: string;
  name: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

function errMsg(err: string): string {
  if (err === "csrf") return "Request blocked (CSRF). Refresh and try again.";
  if (err === "revoke_failed") return "Could not revoke that key.";
  return err;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) redirect("/login");

  const session = await loadWebSession(token);
  if (!session) redirect("/login");

  const sp = await searchParams;
  const createdKey = typeof sp.created === "string" ? sp.created : null;
  const revoked = sp.revoked === "1";
  const err = typeof sp.err === "string" ? sp.err : null;

  const [user, keys] = await Promise.all([
    sqlAsAdmin((c) =>
      c.query<{ email: string | null }>(`SELECT email FROM users WHERE id = $1`, [
        session.userId,
      ])
    ),
    sqlAsAdmin((c) =>
      c.query<KeyRow>(
        `SELECT id, key_prefix, name, created_at, last_used_at, revoked_at
           FROM api_keys
          WHERE user_id = $1
          ORDER BY created_at DESC`,
        [session.userId]
      )
    ),
  ]);

  const email = user.rows[0]?.email ?? "(no email)";
  const publicUrl =
    (process.env.PUBLIC_URL || "").replace(/\/+$/, "") ||
    "https://your-app.vercel.app";

  const mcpSnippet = createdKey
    ? JSON.stringify(
        {
          mcpServers: {
            sessionvault: {
              url: `${publicUrl}/api/mcp`,
              headers: { Authorization: `Bearer ${createdKey}` },
            },
          },
        },
        null,
        2
      )
    : null;

  return (
    <div className="shell">
      <nav className="site-nav">
        <Link href="/" className="brand">
          Session<span>Vault</span>
        </Link>
        <div className="nav-links">
          <Link href="/">Home</Link>
          <Link href="/dashboard">Dashboard</Link>
          <form method="POST" action="/api/auth/logout" style={{ display: "inline" }}>
            <button type="submit" className="btn btn-ghost btn-small">
              Log out
            </button>
          </form>
        </div>
      </nav>

      <section className="section" style={{ borderTop: "none" }}>
        <h2>Dashboard</h2>
        <p>
          Signed in as <code>{email}</code>
        </p>

        {err ? <p className="error">{errMsg(err)}</p> : null}
        {revoked ? <p className="success">Key revoked.</p> : null}

        {createdKey && mcpSnippet ? (
          <div className="panel one-time" style={{ marginBottom: 14 }}>
            <p style={{ margin: "0 0 8px" }}>
              <span className="badge warn">Shown once</span> API key
            </p>
            <pre>{createdKey}</pre>
            <p className="muted" style={{ margin: "8px 0" }}>
              Copy now. Only the hash is stored; this value will not be shown
              again.
            </p>
            <h3 style={{ margin: "12px 0 6px", fontSize: 13 }}>Client config</h3>
            <pre>{mcpSnippet}</pre>
          </div>
        ) : null}

        <div className="panel">
          <h3 style={{ margin: "0 0 8px", fontSize: 13 }}>API keys</h3>
          <div className="table-wrap">
            <table className="keys">
              <thead>
                <tr>
                  <th>Prefix</th>
                  <th>Name</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {keys.rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      No keys yet.
                    </td>
                  </tr>
                ) : (
                  keys.rows.map((k) => (
                    <tr key={k.id}>
                      <td>
                        <code>{k.key_prefix}...</code>
                      </td>
                      <td>{k.name ?? "-"}</td>
                      <td>{new Date(k.created_at).toISOString().slice(0, 10)}</td>
                      <td>
                        {k.last_used_at
                          ? new Date(k.last_used_at).toISOString().slice(0, 10)
                          : "never"}
                      </td>
                      <td>
                        {k.revoked_at ? (
                          <span className="badge warn">revoked</span>
                        ) : (
                          <form method="POST" action="/api/keys/revoke">
                            <input type="hidden" name="key_id" value={k.id} />
                            <button type="submit" className="btn-danger">
                              Revoke
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <form
            method="POST"
            action="/api/keys/create"
            style={{ marginTop: 14, display: "grid", gap: 6, maxWidth: 320 }}
          >
            <label className="label" htmlFor="name">
              Label (optional)
            </label>
            <input
              className="input"
              id="name"
              name="name"
              type="text"
              maxLength={60}
              placeholder="laptop"
            />
            <button type="submit" className="btn btn-small">
              Create key
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
