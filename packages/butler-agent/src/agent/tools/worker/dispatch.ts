import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const dispatchWorkerToolDefinition = {
  type: "function",
  name: "dispatch_worker",
  description: "Start a background Butler worker for work that should leave the current chat turn and report later. Use this only when the user asks for background, async, worker, or delegated execution, or when the task is too long, risky, or review-heavy for turn-local tools.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      task: {
        type: "string",
        description: "Concrete worker task description and success criteria.",
      },
      project_path: {
        type: "string",
        description: "Absolute project path. Defaults to the Butler repository.",
      },
    },
    required: [
      "task",
    ],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const dispatchWorkerToolMetadata = {
  category: "dispatch",
  tags: [
    "worker",
    "background",
    "simple",
    "task",
    "워커",
    "백그라운드",
  ],
  safetyNotes: [
    "Do not claim dispatch unless the tool succeeds.",
  ],
} satisfies ToolCapabilityMetadata;
