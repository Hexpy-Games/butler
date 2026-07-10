import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const grepFilesToolDefinition: ButlerToolDefinition = {
  type: "function",
  name: "grep_files",
  description: "Search bounded workspace text files. Requires pattern; supports literal/regex, context, truncation, include/exclude globs, brace sets (*.{ts,js}), and recursive slash-free filename globs. Use one scoped pattern and candidate-sized max_matches, then read candidates.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      workspace_root: { type: "string" },
      pattern: { type: "string" },
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
