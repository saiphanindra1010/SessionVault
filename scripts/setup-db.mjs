#!/usr/bin/env node
/**
 * Apply sql/schema.sql to the DATABASE_URL. Idempotent — safe to re-run.
 *
 * Usage:
 *   DATABASE_URL="postgres://..." pnpm sv:setup-db
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const here = dirname(fileURLToPath(import.meta.url));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const sql = neon(url);
const schema = readFileSync(resolve(here, "..", "sql", "schema.sql"), "utf8");

// neon serverless: batch statements via unsafe multi-statement.
// The SQL file wraps DDL in BEGIN/COMMIT so we just execute as one blob.
console.log(`[sv:setup-db] applying schema to ${maskDbUrl(url)} ...`);
try {
  // .query(sql) with a plain string runs it as a single simple query. Neon's
  // HTTP endpoint doesn't allow multi-statement in ONE call, so we split.
  const statements = splitSqlStatements(schema);
  for (const stmt of statements) {
    if (!stmt.trim()) continue;
    await sql.query(stmt);
  }
  console.log(`[sv:setup-db] done. ${statements.length} statements applied.`);
} catch (err) {
  console.error(`[sv:setup-db] failed: ${err.message}`);
  process.exit(1);
}

function splitSqlStatements(text) {
  // Strip -- line comments, then split on unquoted semicolons. This is not a
  // full parser but it handles our own controlled schema.sql just fine.
  const noComments = text.replace(/--.*$/gm, "");
  const out = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let inDollar = false;
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];
    if (ch === "$" && noComments[i + 1] === "$") {
      inDollar = !inDollar;
      cur += "$$";
      i++;
      continue;
    }
    if (!inDollar) {
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
    }
    if (ch === ";" && !inSingle && !inDouble && !inDollar) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function maskDbUrl(u) {
  try {
    const url = new URL(u);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return u.replace(/:[^:@/]+@/, ":***@");
  }
}
