import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const grepFilesToolDefinition: ButlerToolDefinition = {
  type: "function",
  name: "grep_files",
  description: "Search bounded UTF-8 workspace text in deterministic source-priority then path/line order. pattern is literal unless regex=true. Use root and canonical include_globs/exclude_globs to narrow discovery; continue with a returned next_cursor when present.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      pattern: {
        type: "string",
        description: "Pattern searched inside the active workspace; paths and globs are workspace-relative.",
      },
      root: {
        type: "string",
        description: "Workspace-relative directory to search. Defaults to the active workspace root.",
      },
      regex: { type: "boolean" },
      case_sensitive: { type: "boolean" },
      include_globs: { type: "array", items: { type: "string" } },
      exclude_globs: { type: "array", items: { type: "string" } },
      context_lines: { type: "integer", minimum: 0, maximum: 10 },
      max_matches: { type: "integer", minimum: 1, maximum: 1000 },
      max_bytes_per_file: { type: "integer", minimum: 1, maximum: 1048576 },
      max_output_bytes: { type: "integer", minimum: 1, maximum: 4194304 },
      max_files: { type: "integer", minimum: 1, maximum: 50000 },
      max_dirs: { type: "integer", minimum: 1, maximum: 10000 },
      max_depth: { type: "integer", minimum: 0, maximum: 100 },
      timeout_ms: { type: "integer", minimum: 10, maximum: 30000 },
      cursor: { type: "string" },
    },
    required: ["pattern"],
  },
  effectBoundary: "none",
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
};

export const grepFilesToolMetadata: ToolCapabilityMetadata = {
  category: "file",
  tags: ["file", "grep", "search", "native"],
  safetyNotes: ["Searches only regular text files inside the workspace path guard."],
  satisfiesCompletionObligations: [],
};
