/**
 * The single interface all storage backends implement. `tools.ts` speaks only
 * this — it doesn't know whether it's talking to local Mem0 or hosted Neon.
 */

export type SessionInput = {
  name: string;
  repo: string;
  summary: string;
  decisions: string[];
  todos: string[];
  files: string[];
  errors: string[];
};

export type SessionRecord = SessionInput & {
  savedAt: string;
};

export type MemoryHit = {
  memory: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

export type SessionSummary = {
  name: string;
  repo: string;
  summary: string;
  savedAt: string;
};

export type SaveResult = {
  status: "saved";
  name: string;
  timestamp: string;
  facts_extracted: number;
};

export type LoadResult =
  | { found: false }
  | { found: true; session: SessionRecord; facts?: MemoryHit[] };

export type LoadMode = "brief" | "normal" | "full";

export interface MemoryBackend {
  saveSession(input: SessionInput): Promise<SaveResult>;
  loadSession(name: string, mode: LoadMode): Promise<LoadResult>;
  deleteSession(name: string): Promise<{ deleted: number }>;
  listSessions(repo?: string): Promise<SessionSummary[]>;
  searchMemories(query: string, topK: number, repo?: string): Promise<MemoryHit[]>;
  searchWithinBudget(
    query: string,
    maxTokens: number,
    repo?: string
  ): Promise<{ memories: MemoryHit[]; tokens_used: number }>;
}

/**
 * Shared helper: given a full record, return a "brief" version with all
 * arrays cleared. Kept here so both backends behave identically.
 */
export function toBrief(session: SessionRecord): SessionRecord {
  return { ...session, decisions: [], todos: [], files: [], errors: [] };
}

/**
 * Shared helper: pack a session into a single searchable text blob. Used by
 * backends that need to hand text to an embedder or an LLM.
 */
export function sessionText(input: SessionInput): string {
  const lines = [
    `Session: ${input.name}`,
    `Repo: ${input.repo}`,
    `Summary: ${input.summary}`,
  ];
  if (input.decisions.length) lines.push(`Decisions: ${input.decisions.join("; ")}`);
  if (input.todos.length) lines.push(`TODOs: ${input.todos.join("; ")}`);
  if (input.files.length) lines.push(`Files: ${input.files.join(", ")}`);
  if (input.errors.length) lines.push(`Errors: ${input.errors.join("; ")}`);
  return lines.join("\n");
}
