const ERR: Record<string, string> = {
  email: "Enter a valid email address.",
  rate: "Too many login attempts. Try again in an hour.",
  expired: "That link expired. Request a new one.",
  invalid: "That link is invalid. Request a new one.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const sent = sp.sent === "1";
  const errKey = typeof sp.err === "string" ? sp.err : "";
  const err = ERR[errKey];

  return (
    <div className="shell">
      <nav className="site-nav">
        <span className="brand">
          Session<span>Vault</span>
        </span>
      </nav>

      <section className="section" style={{ borderTop: "none", maxWidth: 360 }}>
        <h2>Sign in</h2>
        <p>One-time email link. New emails create an account on first verify.</p>

        <div className="panel">
          {sent ? (
            <p className="success">
              Check your email. Link expires in 15 minutes.
            </p>
          ) : (
            <form method="POST" action="/api/auth/login">
              {err ? <p className="error">{err}</p> : null}
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                className="input"
                id="email"
                name="email"
                type="email"
                required
                maxLength={254}
                placeholder="you@company.com"
                autoComplete="email"
              />
              <div style={{ marginTop: 10 }}>
                <button type="submit" className="btn">
                  Send link
                </button>
              </div>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
