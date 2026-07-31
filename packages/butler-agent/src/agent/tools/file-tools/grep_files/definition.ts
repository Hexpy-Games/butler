import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const grepFilesToolDefinition: ButlerToolDefinition = {
  type: "function",
  name: "grep_files",
  description: "Search bounded workspace text in deterministic source-first order. `pattern` is literal unless `regex=true`. Supports context, truncation, root-relative include/exclude globs, brace sets, and recursive filename globs. Use one scoped pattern and candidate-sized max_matches, then read a candidate.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      pattern: {
        type: "string",
        description: "Pattern searched inside the active workspace; paths and globs are workspace-relative.",
      },
      regex: { type: "boolean" },
      case_sensitive: { type: "boolean" },
      include: { type: "array", items: { type: "string" } },
      include_globs: { type: "array", items: { type: "string" } },
      exclude: { type: "array", items: { type: "string" } },
      exclude_globs: { type: "array", items: { type: "string" } },
      context: { type: "integer", minimum: 0, maximum: 10 },
      context_lines: { type: "integer", minimum: 0, maximum: 10 },
      max_matches: { type: "integer", minimum: 1, maximum: 1000 },
      max_bytes_per_file: { type: "integer", minimum: 1, maximum: 1048576 },
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
