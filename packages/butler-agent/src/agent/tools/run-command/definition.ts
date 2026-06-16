import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const runCommandToolDefinition = {
  type: "function",
  name: "run_command",
  description: "Run a single non-interactive bash command in the active Butler or Steward session workspace and return structured stdout, stderr, exit status, timeout state, and compacted output artifact references when needed. For generated artifacts that are not intentional project/workspace files, write under $BUTLER_ARTIFACTS_DIR instead of creating a workspace-root artifacts/ directory. Butler auto-verifies generated artifacts only under $BUTLER_ARTIFACTS_DIR; workspace files are durable evidence only when listed in output_paths. Prefer focused output over broad dumps: use structured extraction or case-insensitive search for manifest/config/script/log questions, and do not infer absence from one exact case-sensitive match. Keep the command argument JSON-safe: prefer one-line commands, avoid literal newlines inside the command string, and split long scripts into small commands when needed.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
        description: "The non-interactive bash command to execute.",
      },
      cwd: {
        type: "string",
        description: "Optional working directory. Relative paths resolve from the active session workspace.",
      },
      timeout_ms: {
        type: "integer",
        description: "Optional timeout in milliseconds.",
      },
      max_output_tokens: {
        type: "integer",
        description: "Optional model-facing stdout/stderr token budget before artifact compaction.",
      },
      output_paths: {
        type: "array",
        description: "Intentional workspace paths or Butler data artifact labels this command is expected to create or verify. Required for workspace-root durable deliverables; use artifacts/generated/... for files written through $BUTLER_ARTIFACTS_DIR.",
        items: {
          type: "string",
        },
      },
      output_mode: {
        type: "string",
        enum: [
          "auto",
          "silent_on_success",
          "full",
        ],
        description: "Optional output behavior: 'auto' suppresses validation command output on success and bounds failures (default), 'silent_on_success' suppresses all successful output, 'full' preserves all output.",
      },
    },
    required: [
      "command",
    ],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const runCommandToolMetadata = {
  category: "command",
  tags: [
    "bash",
    "shell",
    "command",
    "terminal",
    "verify",
    "file",
    "명령",
    "쉘",
    "검증",
    "파일",
  ],
  safetyNotes: [
    "Runs non-interactive bash in the active session workspace.",
    "Generated Butler artifacts are auto-verified only under $BUTLER_ARTIFACTS_DIR; declare intentional workspace outputs in output_paths.",
    "Large stdout/stderr is compacted into Butler-owned tool-output artifacts.",
  ],
} satisfies ToolCapabilityMetadata;
