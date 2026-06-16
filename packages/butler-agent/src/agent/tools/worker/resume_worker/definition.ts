import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const resumeWorkerToolDefinition = {
  type: "function",
  name: "resume_worker",
  description: "Resume a recoverable Butler worker that was interrupted by a restart, crash, or dead process. Use this when the user says to continue, resume, pick up the worker, or asks about a RUNNING/RECOVERABLE worker that did not finish normally.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      task_id: {
        type: "string",
        description: "Recoverable task id. If omitted, Butler resumes the most recent RECOVERABLE task.",
      },
    },
    required: [],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const resumeWorkerToolMetadata = {
  category: "dispatch",
  tags: [
    "worker",
    "resume",
    "recoverable",
    "continue",
  ],
  safetyNotes: [
    "Use only for recoverable workers with durable context.",
  ],
} satisfies ToolCapabilityMetadata;
