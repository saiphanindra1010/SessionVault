import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResult, toolError } from "./mcp-response.js";
import { getBackend } from "./memory/factory.js";

/**
 * Field caps — enforced here so a runaway client can't ship us 100MB of
 * "decisions". Hosted mode also has a 1MB body cap in the HTTP handler; this
 * is a second, more granular layer.
 */
const MAX_STR = 4_000;
const MAX_ARR = 200;
const MAX_NAME = 200;
const MAX_REPO = 200;

const sessionFields = {
  name: z
    .string()
    .min(1)
    .max(MAX_NAME)
    .describe("Unique session name (used for exact load/delete)"),
  repo: z
    .string()
    .max(MAX_REPO)
    .default("")
    .describe("Repository path or name (used for scoping)"),
  summary: z
    .string()
    .min(1)
    .max(MAX_STR)
    .describe("Compressed 1-3 line summary"),
  decisions: z
    .array(z.string().max(MAX_STR))
    .max(MAX_ARR)
    .default([])
    .describe("Key decisions made"),
  todos: z
    .array(z.string().max(MAX_STR))
    .max(MAX_ARR)
    .default([])
    .describe("Remaining TODOs"),
  files: z
    .array(z.string().max(MAX_STR))
    .max(MAX_ARR)
    .default([])
    .describe("Key files touched"),
  errors: z
    .array(z.string().max(MAX_STR))
    .max(MAX_ARR)
    .default([])
    .describe("Notable errors encountered"),
};

export function registerTools(server: McpServer): void {
  server.tool(
    "save_session",
    "Save a structured session. Stores an encrypted verbatim record + a searchable embedding. Same name overwrites the previous save.",
    sessionFields,
    async (input) => {
      try {
        const backend = getBackend();
        return jsonResult(
          await backend.saveSession({
            name: input.name,
            repo: input.repo ?? "",
            summary: input.summary,
            decisions: input.decisions ?? [],
            todos: input.todos ?? [],
            files: input.files ?? [],
            errors: input.errors ?? [],
          })
        );
      } catch (e) {
        return toolError("Save failed", e);
      }
    }
  );

  server.tool(
    "load_session",
    "Deterministically load a session by exact name. brief=summary only, normal=full structured record, full=record + related hits.",
    {
      name: z.string().min(1).max(MAX_NAME).describe("Exact session name"),
      mode: z.enum(["brief", "normal", "full"]).default("normal"),
    },
    async ({ name, mode }) => {
      try {
        const result = await getBackend().loadSession(name, mode);
        if (!result.found) {
          return toolError(
            "Load failed",
            `No session named '${name}'. Use list_sessions to see what's saved.`
          );
        }
        return jsonResult(result);
      } catch (e) {
        return toolError("Load failed", e);
      }
    }
  );

  server.tool(
    "search_sessions",
    "Semantic search across all your sessions (or a single repo). Optional max_tokens caps output size.",
    {
      query: z.string().min(1).max(MAX_STR),
      max_results: z.number().int().min(1).max(20).default(5),
      max_tokens: z.number().int().min(50).max(4000).optional(),
      repo: z.string().max(MAX_REPO).optional().describe("Restrict search to a single repo"),
    },
    async ({ query, max_results, max_tokens, repo }) => {
      try {
        const backend = getBackend();
        if (max_tokens) {
          return jsonResult(await backend.searchWithinBudget(query, max_tokens, repo));
        }
        const hits = await backend.searchMemories(query, max_results ?? 5, repo);
        return jsonResult(hits.length ? hits : { message: "No memories found." });
      } catch (e) {
        return toolError("Search failed", e);
      }
    }
  );

  server.tool(
    "list_sessions",
    "List saved sessions (newest first). Optional repo filter. Returns name, repo, summary, savedAt.",
    {
      repo: z.string().max(MAX_REPO).optional().describe("Restrict to a single repo"),
    },
    async ({ repo }) => {
      try {
        const items = await getBackend().listSessions(repo);
        return jsonResult(items.length ? items : { message: "No sessions stored." });
      } catch (e) {
        return toolError("List failed", e);
      }
    }
  );

  server.tool(
    "delete_session",
    "Delete a saved session by exact name.",
    {
      name: z.string().min(1).max(MAX_NAME).describe("Exact session name to delete"),
    },
    async ({ name }) => {
      try {
        const res = await getBackend().deleteSession(name);
        if (res.deleted === 0) {
          return toolError("Delete failed", `No session named '${name}'.`);
        }
        return jsonResult({ status: "deleted", name, memories_removed: res.deleted });
      } catch (e) {
        return toolError("Delete failed", e);
      }
    }
  );
}
