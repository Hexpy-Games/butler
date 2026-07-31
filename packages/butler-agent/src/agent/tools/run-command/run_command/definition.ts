import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const runCommandToolDefinition = {
  type: "function",
  name: "run_command",
  description: "Run one non-interactive command in the active Butler or Steward workspace through Butler's platform-neutral command executor and return structured stdout, stderr, exit status, timeout state, and compacted artifact references when needed. For validation such as typecheck, lint, test, or project checks, set validation_suite to a stable suite name so the runtime records a structured validation receipt. Write generated artifacts under $BUTLER_ARTIFACTS_DIR unless they are intentional workspace files listed in output_paths. Prefer cross-platform executables with explicit arguments, focused output over broad dumps, and JSON-safe command text with no literal newlines.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
        description: "The non-interactive command to execute. Prefer one cross-platform executable with explicit arguments and avoid shell-dialect-specific syntax.",
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
      state_effect: {
        type: "string",
        enum: ["read_only", "mutation", "validation"],
        description: "Optional declaration of the command's intended state effect. When the runtime has focused a workspace action after excessive inspection, this must be 'mutation'; the runtime then requires verified post-execution workspace or durable-artifact evidence rather than trusting command text.",
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
  effectBoundary: "dynamic",
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const runCommandToolMetadata = {
  category: "command",
  tags: [
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
    "Runs through the platform-neutral command executor in the active session workspace.",
    "Generated Butler artifacts are auto-verified only under $BUTLER_ARTIFACTS_DIR; declare intentional workspace outputs in output_paths.",
    "Large stdout/stderr is compacted into Butler-owned tool-output artifacts.",
  ],
} satisfies ToolCapabilityMetadata;
