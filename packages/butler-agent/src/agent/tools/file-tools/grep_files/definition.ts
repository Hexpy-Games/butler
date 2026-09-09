import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const grepFilesToolDefinition: ButlerToolDefinition = {
  type: "function",
  name: "grep_files",
  description: "Search UTF-8 workspace text with a regular expression (literal=false), or exact text (literal=true). Use root and include_globs/exclude_globs to narrow discovery; continue with the returned next_cursor when present. Runtime owns traversal and output budgets.",
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
      literal: { type: "boolean", description: "Use false for regular expressions such as foo|bar; true to match the pattern as exact text." },
      case_sensitive: { type: "boolean" },
      include_globs: { type: "array", items: { type: "string" } },
      exclude_globs: { type: "array", items: { type: "string" } },
      context_lines: { type: "integer", minimum: 0, maximum: 10 },
      max_matches: { type: "integer", minimum: 1, maximum: 1000 },
      cursor: { type: "string" },
    },
    required: ["pattern", "literal"],
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
