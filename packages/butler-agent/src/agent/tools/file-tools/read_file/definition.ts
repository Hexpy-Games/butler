import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const readFileToolDefinition: ButlerToolDefinition = {
  type: "function",
  name: "read_file",
  description: "Read a bounded UTF-8 text file inside the active workspace with path guard, binary/sensitive-path checks, line range controls, truncation metadata, and evidence receipts.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "File path inside the active workspace. Prefer a workspace-relative path; a contained absolute path shown by a tool is also accepted.",
      },
      start_line: { type: "integer", minimum: 1 },
      limit_lines: { type: "integer", minimum: 1, maximum: 10000 },
      max_bytes: { type: "integer", minimum: 1, maximum: 1048576 },
    },
    required: ["path"],
  },
  effectBoundary: "none",
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
};

export const readFileToolMetadata: ToolCapabilityMetadata = {
  category: "file",
  tags: ["file", "read", "native"],
  safetyNotes: ["Only reads files inside the supplied workspace root after realpath guard checks."],
  satisfiesCompletionObligations: ["source_verified"],
};
