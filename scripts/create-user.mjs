#!/usr/bin/env node
/**
 * Provision a new SessionVault user + API key.
 *
 * Usage:
 *   pnpm sv:create-user -- --email you@example.com --name "you"
 *
 * On success, prints the API key EXACTLY ONCE. Copy it now — we only ever
 * store its hash.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash, createCipheriv } from "node:crypto";
import { Pool } from "@neondatabase/serverless";

const here = dirname(fileURLToPath(import.meta.url));

const args = parseArgs(process.argv.slice(2));
if (!args.email) {
  console.error("Usage: pnpm sv:create-user -- --email you@example.com [--name label]");
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL;
const masterKeyB64 = process.env.SESSIONVAULT_MASTER_KEY;

if (!dbUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
if (!masterKeyB64) {
  console.error("SESSIONVAULT_MASTER_KEY is required. Run: pnpm sv:generate-keys");
  process.exit(1);
}

const masterKey = Buffer.from(masterKeyB64, "base64");
if (masterKey.length !== 32) {
  console.error(`SESSIONVAULT_MASTER_KEY must decode to 32 bytes; got ${masterKey.length}.`);
  process.exit(1);
}

const dek = randomBytes(32);
const { wrapped, nonce } = wrap(dek, masterKey);

const apiKey = "sv_live_" + randomBytes(24).toString("base64url");
const keyHash = createHash("sha256").update(apiKey, "utf8").digest();
const keyPrefix = apiKey.substring(0, 12);

const pool = new Pool({ connectionString: dbUrl });
try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userRes = await client.query(
      `INSERT INTO users (email, display_name, dek_wrapped, dek_nonce)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [args.email, args.name ?? null, wrapped, nonce]
    );

    let userId = userRes.rows[0]?.id;
    if (!userId) {
      const existing = await client.query(
        `SELECT id FROM users WHERE email = $1`,
        [args.email]
      );
      userId = existing.rows[0]?.id;
      if (!userId) throw new Error("failed to create or find user");
      console.log(`[sv:create-user] user ${args.email} already exists (id=${userId}), adding new key`);
    }

    await client.query(
      `INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
       VALUES ($1, $2, $3, $4)`,
      [userId, keyHash, keyPrefix, args.name ?? null]
    );
    await client.query("COMMIT");

    console.log("");
    console.log("========================================================");
    console.log(" API KEY (copy now — will not be shown again):");
    console.log("");
    console.log("   " + apiKey);
    console.log("");
    console.log(` user_id: ${userId}`);
    console.log(` email:   ${args.email}`);
    console.log("========================================================");
    console.log("");
    console.log("Add to your MCP client config:");
    console.log("");
    console.log("  {");
    console.log('    "mcpServers": {');
    console.log('      "sessionvault": {');
    console.log('        "url": "https://YOUR-DEPLOYMENT.vercel.app/api/mcp",');
    console.log(`        "headers": { "Authorization": "Bearer ${apiKey}" }`);
    console.log("      }");
    console.log("    }");
    console.log("  }");
    console.log("");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
} catch (err) {
  console.error(`[sv:create-user] failed: ${err.message}`);
  process.exit(1);
} finally {
  await pool.end();
}

// -------- helpers ---------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--email") out.email = argv[++i];
    else if (a === "--name") out.name = argv[++i];
  }
  return out;
}

function wrap(dek, mk) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", mk, nonce, { authTagLength: 16 });
  const enc = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { wrapped: Buffer.concat([enc, tag]), nonce };
}
