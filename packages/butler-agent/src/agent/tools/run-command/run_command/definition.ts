import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const runCommandToolDefinition = {
  type: "function",
  name: "run_command",
  description: "Run one non-interactive bash command in the active Butler or Steward workspace and return structured stdout, stderr, exit status, timeout state, and compacted artifact references when needed. For validation such as typecheck, lint, test, or project checks, set validation_suite to a stable suite name so the runtime records a structured validation receipt. Write generated artifacts under $BUTLER_ARTIFACTS_DIR unless they are intentional workspace files listed in output_paths. Prefer focused output over broad dumps, and keep command JSON-safe with no literal newlines.",
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
      validation_suite: {
        type: "string",
        description: "Optional stable validation suite id for verification commands. When set, emits a structured validation receipt; failed receipts must be cleared by a later passing receipt for the same suite before completion.",
      },
      output_mode: {
        type: "string",
        enum: [
          "auto",
          "silent_on_success",
          "full",
        ],
        description: "Optional output behavior: 'auto' suppresses successful output only for commands with an explicit validation_suite and bounds failures (default), 'silent_on_success' suppresses all successful output, 'full' preserves all output.",
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
