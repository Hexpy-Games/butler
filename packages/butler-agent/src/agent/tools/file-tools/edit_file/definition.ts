import type {
  ButlerToolDefinition,
  ToolCapabilityMetadata,
} from "../../types.ts";

export const editFileToolDefinition: ButlerToolDefinition = {
  type: "function",
  name: "edit_file",
  description: "Make one small, exact change to an existing UTF-8 workspace file. old_text is located exactly in the current file; start_line is an optional location hint, and a unique old_text occurrence is accepted when the hint is stale. Multiple unresolved occurrences are rejected. Use write_file to create a file or replace its complete content. Use Project Ledger tools for Ledger files.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "File path inside the active workspace. Prefer a workspace-relative path; a contained absolute path shown by a tool is also accepted.",
      },
      start_line: {
        type: "integer",
        minimum: 1,
        description: "Optional one-based location hint for old_text. It may be stale after earlier edits; the exact text remains authoritative.",
      },
      old_text: {
        type: "string",
        minLength: 1,
        description: "Exact existing text copied from the current file. Include indentation and line breaks exactly as they appear.",
      },
      new_text: {
        type: "string",
        description: "Exact replacement text. An empty string removes old_text.",
      },
      expected_sha256: {
        type: "string",
        description: "Optional SHA-256 of the complete current file. The edit is rejected when it does not match.",
      },
    },
    required: ["path", "old_text", "new_text"],
  },
  effectBoundary: "reviewed_persistent",
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
};

export const editFileToolMetadata: ToolCapabilityMetadata = {
  category: "file",
  tags: ["file", "edit", "native"],
  safetyNotes: [
    "Edits one exact text range in an existing regular UTF-8 file inside the workspace after realpath and sensitive-path checks.",
    "Supports stale-byte protection for guarded callers, rejects symbolic-link leaves and Project Ledger paths, and writes through an atomic same-directory replacement.",
    "One Butler agent process serializes its write_file and edit_file mutations. External editors and other processes are not locked.",
  ],
  satisfiesCompletionObligations: ["durable_artifact"],
};
