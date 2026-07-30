/**
 * Thin OpenAI embeddings client. We use fetch directly (rather than the
 * `openai` package) to keep the Vercel function bundle small.
 *
 * Model: text-embedding-3-small (1536 dims, matches sql/schema.sql).
 * Cost:  ~$0.02 per million tokens — a rounding error for this workload.
 */

const OPENAI_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_MODEL = "text-embedding-3-small";
export const EMBED_DIMS = 1536;

/** Request timeout so a hung provider doesn't consume Vercel function budget. */
const TIMEOUT_MS = 8_000;

export type EmbeddingProvider = {
  embed(text: string): Promise<number[]>;
};

class OpenAIEmbeddings implements EmbeddingProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_MODEL
  ) {}

  async embed(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: text,
          encoding_format: "float",
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`OpenAI embeddings ${res.status}: ${truncate(body, 200)}`);
      }
      const data = (await res.json()) as {
        data?: { embedding: number[] }[];
      };
      const vec = data.data?.[0]?.embedding;
      if (!vec || vec.length !== EMBED_DIMS) {
        throw new Error(
          `OpenAI embeddings returned unexpected dims: ${vec?.length ?? 0} (want ${EMBED_DIMS})`
        );
      }
      return vec;
    } finally {
      clearTimeout(timer);
    }
  }
}

let cached: EmbeddingProvider | null = null;
export function getEmbeddingProvider(): EmbeddingProvider {
  if (cached) return cached;
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY is required for the neon backend.");
  }
  const model = process.env.OPENAI_EMBED_MODEL || DEFAULT_MODEL;
  cached = new OpenAIEmbeddings(key, model);
  return cached;
}

/** Test hook: inject a custom provider. */
export function _setEmbeddingProviderForTests(p: EmbeddingProvider | null): void {
  cached = p;
}

/**
 * Format a Buffer or number[] as pgvector's textual literal:  '[1,2,3]'.
 * Vector columns accept this in parameterized queries as ::vector.
 */
export function toVectorLiteral(vec: number[]): string {
  // Postgres expects '[1,2,3]' as a string; the driver will cast to vector.
  return `[${vec.join(",")}]`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
