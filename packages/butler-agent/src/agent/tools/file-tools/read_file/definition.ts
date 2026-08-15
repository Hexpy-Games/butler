import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const readFileToolDefinition: ButlerToolDefinition = {
  type: "function",
  name: "read_file",
  description: "Read one bounded UTF-8 workspace file or 1-20 files in request order with path guard, binary/UTF-8 checks, aggregate limits, stale-safe continuation, and evidence receipts.",
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
      requests: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        description: "Canonical bounded batch requests. Use requests instead of path, never both.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            start_line: { type: "integer", minimum: 1 },
            limit_lines: { type: "integer", minimum: 1, maximum: 10000 },
            max_bytes: { type: "integer", minimum: 1, maximum: 1048576 },
          },
          required: ["path"],
        },
      },
      max_total_bytes: { type: "integer", minimum: 1, maximum: 4194304 },
      cursor: { type: "string" },
    },
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
