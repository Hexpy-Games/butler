import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const listWorkStreamsToolDefinition = {
  type: "function",
  name: "list_work_streams",
  description: "List Butler-owned durable WorkStreams for the active session or project. Use to preserve context switching across multiple async issues.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      session_id: {
        type: "string",
        description: "Optional session id. Defaults to the active session.",
      },
      project_id: {
        type: "string",
        description: "Optional project id filter.",
      },
      include_terminal: {
        type: "boolean",
        description: "When true, include complete and failed streams.",
      },
    },
    required: [],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const listWorkStreamsToolMetadata = {
  category: "work",
  tags: [
    "workstream",
    "fsm",
    "state",
    "async",
    "project",
    "작업",
    "상태",
  ],
  safetyNotes: [
    "Returns public-safe state summaries only, not hidden reasoning.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
