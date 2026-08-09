import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const runCommandToolDefinition = {
  type: "function",
  name: "run_command",
  description: "Run a non-interactive command in the active workspace through Butler's platform-neutral command executor. Required summary is the model-authored compact action label shown to the user, not a purpose sentence: read the requested command and write labels such as '실행: git commit', '커밋 후 푸시', or '검증: bun test'. It never authorizes execution. Set validation_suite for validation receipts. Generated artifacts go under $BUTLER_ARTIFACTS_DIR. Existing intentional workspace files may be published by listing them in output_paths after a successful command. Prefer cross-platform executables with explicit arguments and JSON-safe command text.",
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
        maxLength: 32,
        pattern: "^[^\\r\\n]*\\S[^\\r\\n]*$",
        description: "Required one-line model-authored action label based on the actual command, at most 32 characters. Use compact labels such as '실행: git commit', '커밋 후 푸시', or '검증: bun test'; do not write a purpose sentence or include arguments, paths, messages, URLs, or secrets. Presentation only; it cannot authorize or alter the command or result.",
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
        description: "Intentional existing workspace paths or artifact labels to publish as durable deliverables after command success. Use artifacts/generated/... for $BUTLER_ARTIFACTS_DIR files. If none of the declared files can be published, the tool returns a recoverable failure.",
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
        enum: ["read_only", "mutation", "validation", "remote_observation"],
        description: "Effect: mutation and remote_observation require full access plus accepted Plan Review; remote_observation is an audited network effect for remote status/log reads. validation uses validation_suite.",
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
