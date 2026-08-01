/**
 * Hosted backend: Neon Postgres + pgvector + OpenAI embeddings + AES-256-GCM
 * envelope encryption of session content.
 *
 * Every user-scoped query runs inside sqlAsUser() so RLS applies. Even if
 * this file had a bug and forgot the WHERE user_id = ... clause, the DB
 * would return zero rows.
 */

import { currentUser } from "../security/context.js";
import { decryptString, encryptString } from "../security/crypto.js";
import { sqlAsUser } from "../neon/client.js";
import { EMBED_DIMS, getEmbeddingProvider, toVectorLiteral } from "../neon/embeddings.js";
import {
  sessionText,
  toBrief,
  type LoadMode,
  type LoadResult,
  type MemoryBackend,
  type MemoryHit,
  type SaveResult,
  type SessionInput,
  type SessionRecord,
  type SessionSummary,
} from "./types.js";

const PREVIEW_LEN = 120;

export class NeonMemoryBackend implements MemoryBackend {
  async saveSession(input: SessionInput): Promise<SaveResult> {
    const user = currentUser();
    const record: SessionRecord = { ...input, savedAt: new Date().toISOString() };
    const plaintext = JSON.stringify(record);
    const { nonce, ciphertext } = encryptString(plaintext, user.dek);
    const preview = record.summary.substring(0, PREVIEW_LEN);

    const embedding = await this._embed(sessionText(input));

    await sqlAsUser(user.id, async (c) => {
      // Overwrite semantics via the UNIQUE(user_id, name) constraint.
      await c.query(
        `INSERT INTO sessions (
           user_id, name, repo, content_ct, content_nonce, content_preview,
           embedding, metadata, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, now(), now())
         ON CONFLICT (user_id, name) DO UPDATE SET
           repo             = EXCLUDED.repo,
           content_ct       = EXCLUDED.content_ct,
           content_nonce    = EXCLUDED.content_nonce,
           content_preview  = EXCLUDED.content_preview,
           embedding        = EXCLUDED.embedding,
           metadata         = EXCLUDED.metadata,
           updated_at       = now()`,
        [
          user.id,
          input.name,
          input.repo,
          ciphertext,
          nonce,
          preview,
          embedding ? toVectorLiteral(embedding) : null,
          JSON.stringify({ dims: EMBED_DIMS, saved_at: record.savedAt }),
        ]
      );
    });

    return {
      status: "saved",
      name: input.name,
      timestamp: record.savedAt,
      // Neon backend doesn't do LLM fact extraction — the embedding IS the
      // semantic index. Report 1 to keep response shape consistent.
      facts_extracted: embedding ? 1 : 0,
    };
  }

  async loadSession(name: string, mode: LoadMode): Promise<LoadResult> {
    const user = currentUser();
    const rows = await sqlAsUser(user.id, (c) =>
      c.query<{
        content_ct: Buffer;
        content_nonce: Buffer;
      }>(
        `SELECT content_ct, content_nonce
           FROM sessions
          WHERE user_id = $1 AND name = $2
          LIMIT 1`,
        [user.id, name]
      )
    );
    if (!rows.rows.length) return { found: false };

    const row = rows.rows[0]!;
    const plaintext = decryptString(row.content_ct, row.content_nonce, user.dek);
    const session = JSON.parse(plaintext) as SessionRecord;

    if (mode === "brief") return { found: true, session: toBrief(session) };
    if (mode === "normal") return { found: true, session };

    // For the neon backend "full" mode returns the record plus the top
    // semantic hits from OTHER sessions related to this one — useful cross-
    // context recall. We do this by embedding the session text and searching.
    let facts: MemoryHit[] = [];
    try {
      facts = await this.searchMemories(sessionText(session), 5);
    } catch {
      /* facts are an enhancement */
    }
    return { found: true, session, facts };
  }

  async deleteSession(name: string): Promise<{ deleted: number }> {
    const user = currentUser();
    const res = await sqlAsUser(user.id, (c) =>
      c.query(`DELETE FROM sessions WHERE user_id = $1 AND name = $2`, [
        user.id,
        name,
      ])
    );
    return { deleted: res.rowCount ?? 0 };
  }

  async listSessions(repo?: string): Promise<SessionSummary[]> {
    const user = currentUser();
    const rows = await sqlAsUser(user.id, (c) => {
      if (repo) {
        return c.query<{
          name: string;
          repo: string;
          content_preview: string;
          created_at: Date;
          updated_at: Date;
        }>(
          `SELECT name, repo, content_preview, created_at, updated_at
             FROM sessions
            WHERE user_id = $1 AND repo = $2
            ORDER BY updated_at DESC
            LIMIT 200`,
          [user.id, repo]
        );
      }
      return c.query<{
        name: string;
        repo: string;
        content_preview: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT name, repo, content_preview, created_at, updated_at
           FROM sessions
          WHERE user_id = $1
          ORDER BY updated_at DESC
          LIMIT 200`,
        [user.id]
      );
    });

    return rows.rows.map((r) => ({
      name: r.name,
      repo: r.repo,
      summary: r.content_preview,
      savedAt: r.updated_at.toISOString(),
    }));
  }

  async searchMemories(
    query: string,
    topK: number,
    repo?: string
  ): Promise<MemoryHit[]> {
    const user = currentUser();
    const qVec = await this._embed(query);
    if (!qVec) return [];
    const qLit = toVectorLiteral(qVec);

    const rows = await sqlAsUser(user.id, (c) => {
      if (repo) {
        return c.query<{
          name: string;
          repo: string;
          content_ct: Buffer;
          content_nonce: Buffer;
          distance: number;
        }>(
          `SELECT name, repo, content_ct, content_nonce,
                  (embedding <=> $1::vector) AS distance
             FROM sessions
            WHERE user_id = $2 AND repo = $3 AND embedding IS NOT NULL
            ORDER BY embedding <=> $1::vector
            LIMIT $4`,
          [qLit, user.id, repo, topK]
        );
      }
      return c.query<{
        name: string;
        repo: string;
        content_ct: Buffer;
        content_nonce: Buffer;
        distance: number;
      }>(
        `SELECT name, repo, content_ct, content_nonce,
                (embedding <=> $1::vector) AS distance
           FROM sessions
          WHERE user_id = $2 AND embedding IS NOT NULL
          ORDER BY embedding <=> $1::vector
          LIMIT $3`,
        [qLit, user.id, topK]
      );
    });

    return rows.rows.map((r) => {
      const record = JSON.parse(
        decryptString(r.content_ct, r.content_nonce, user.dek)
      ) as SessionRecord;
      return {
        memory: record.summary,
        // pgvector cosine distance ∈ [0,2]; convert to similarity ∈ [0,1].
        score: 1 - Number(r.distance) / 2,
        metadata: {
          session_name: r.name,
          repo: r.repo,
          savedAt: record.savedAt,
        },
      };
    });
  }

  async searchWithinBudget(
    query: string,
    maxTokens: number,
    repo?: string
  ): Promise<{ memories: MemoryHit[]; tokens_used: number }> {
    const hits = await this.searchMemories(query, 20, repo);
    const memories: MemoryHit[] = [];
    let tokensUsed = 0;
    for (const hit of hits) {
      const chunk = JSON.stringify(hit);
      const size = Math.ceil(chunk.length / 4);
      if (tokensUsed + size > maxTokens) break;
      memories.push(hit);
      tokensUsed += size;
    }
    return { memories, tokens_used: tokensUsed };
  }

  // -- internals ----------------------------------------------------------

  private async _embed(text: string): Promise<number[] | null> {
    try {
      return await getEmbeddingProvider().embed(text);
    } catch (err) {
      // We don't want a temporary OpenAI blip to break saves. The row is
      // saved without an embedding and just isn't searchable until re-saved.
      // eslint-disable-next-line no-console
      console.warn(
        `[neon-memory] embedding failed: ${(err as Error).message || err}`
      );
      return null;
    }
  }
}
