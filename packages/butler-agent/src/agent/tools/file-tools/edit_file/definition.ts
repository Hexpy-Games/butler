import type {
  ButlerToolDefinition,
  ToolCapabilityMetadata,
} from "../../types.ts";
import { WORKSPACE_SHA256_PATTERN } from "../shared/workspace-sha256.ts";

export const editFileToolDefinition: ButlerToolDefinition = {
  type: "function",
  name: "edit_file",
  description: "Make one small, exact change in a UTF-8 workspace file or a conflict-safe 2-20 file batch. Single edits locate old_text exactly; start_line is an optional location hint. Batches require each current expected_sha256, preflight all entries, and report bounded partial state on external change. Use write_file for complete content and Project Ledger tools for Ledger files.",
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
        pattern: WORKSPACE_SHA256_PATTERN,
        description: "Optional SHA-256 of the complete current file for a single edit (64 hexadecimal characters; case-insensitive). The edit is rejected when it does not match.",
      },
      edits: {
        type: "array",
        minItems: 2,
        maxItems: 20,
        description: "Conflict-safe batch in request order.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: {
              type: "string",
              minLength: 1,
            },
            start_line: {
              type: "integer",
              minimum: 1,
            },
            old_text: {
              type: "string",
              minLength: 1,
            },
            new_text: {
              type: "string",
            },
            expected_sha256: {
              type: "string",
              pattern: WORKSPACE_SHA256_PATTERN,
            },
          },
          required: ["path", "old_text", "new_text", "expected_sha256"],
        },
      },
    },
    oneOf: [
      {
        required: ["path", "old_text", "new_text"],
        not: { required: ["edits"] },
      },
      {
        required: ["edits"],
        not: {
          anyOf: [
            { required: ["path"] },
            { required: ["start_line"] },
            { required: ["old_text"] },
            { required: ["new_text"] },
            { required: ["expected_sha256"] },
          ],
        },
      },
    ],
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
    "Canonical edits batches contain 2-20 distinct targets, preflight every entry before mutation, and stop with bounded partial state when a later target changes externally.",
    "Supports stale-byte protection for guarded callers, rejects symbolic-link leaves and Project Ledger paths, and writes through an atomic same-directory replacement.",
    "One Butler agent process serializes its write_file and edit_file mutations. External editors and other processes are not locked.",
  ],
  satisfiesCompletionObligations: ["durable_artifact"],
};
