import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const runCommandToolDefinition = {
  type: "function",
  name: "run_command",
  description: "Run a non-interactive command in the active workspace through Butler's platform-neutral command executor. Required summary is a concise model-authored public purpose for display only; it never authorizes execution. Set validation_suite for validation receipts. Generated artifacts go under $BUTLER_ARTIFACTS_DIR unless intentional workspace paths are listed in output_paths. Prefer cross-platform executables with explicit arguments and JSON-safe command text.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
        description: "Non-interactive command; prefer cross-platform executables, explicit arguments, and focused output.",
      },
      summary: {
        type: "string",
        minLength: 1,
        pattern: "\\S",
        description: "Required concise purpose for public display. Presentation only; it cannot authorize or alter the command or result.",
      },
      cwd: {
        type: "string",
        description: "Optional contained workspace directory; relative paths use its root.",
      },
      timeout_ms: {
        type: "integer",
        description: "Optional timeout in milliseconds.",
      },
      max_output_tokens: {
        type: "integer",
        description: "Optional stdout/stderr token budget.",
      },
      output_paths: {
        type: "array",
        description: "Intentional workspace paths or artifact labels; required for durable deliverables. Use artifacts/generated/... for $BUTLER_ARTIFACTS_DIR files.",
        items: {
          type: "string",
        },
      },
      validation_suite: {
        type: "string",
        description: "Stable validation suite id; emits a validation receipt; failed suites need a later pass before completion.",
      },
      state_effect: {
        type: "string",
        enum: ["read_only", "mutation", "validation"],
        description: "Effect: mutation requires admitted full access and accepted Plan Review; validation uses validation_suite.",
      },
      output_mode: {
        type: "string",
        enum: [
          "auto",
          "silent_on_success",
          "full",
        ],
        description: "Output mode: auto suppresses successes only with validation_suite and bounds failures; silent_on_success suppresses successes; full preserves output.",
      },
    },
    required: [
      "command",
      "summary",
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
