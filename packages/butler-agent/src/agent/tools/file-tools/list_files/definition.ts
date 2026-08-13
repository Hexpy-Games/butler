import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const listFilesToolDefinition: ButlerToolDefinition = {
  type: "function",
  name: "list_files",
  description: "Discover regular files under a guarded workspace directory with deterministic bounded results. Use root and include_globs/exclude_globs to narrow discovery, then read a candidate with read_file.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      root: {
        type: "string",
        description: "Workspace-relative directory to inspect. Defaults to the active workspace root.",
      },
      include_globs: {
        type: "array",
        items: { type: "string" },
        description: "Optional workspace-relative file globs applied during traversal.",
      },
      exclude_globs: {
        type: "array",
        items: { type: "string" },
        description: "Optional workspace-relative file or directory globs excluded during traversal.",
      },
      max_results: { type: "integer", minimum: 1, maximum: 1000 },
      max_files: { type: "integer", minimum: 1, maximum: 50000 },
      max_dirs: { type: "integer", minimum: 1, maximum: 10000 },
      max_depth: { type: "integer", minimum: 0, maximum: 100 },
      timeout_ms: { type: "integer", minimum: 10, maximum: 30000 },
      cursor: { type: "string" },
    },
  },
  effectBoundary: "none",
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
};

export const listFilesToolMetadata: ToolCapabilityMetadata = {
  category: "file",
  tags: ["file", "list", "discovery", "native", "read-only"],
  safetyNotes: ["Returns only bounded workspace-relative regular-file metadata after path, sensitive-path, and symlink checks."],
  satisfiesCompletionObligations: [],
};
