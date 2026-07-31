import type { FunctionToolDefinition } from
  "../../../integrations/providers/runtime-contracts.ts";

export const DURABLE_WORK_TOOL_NAMES = [
  "replace_work_plan",
  "record_work_checkpoint",
  "record_work_review",
] as const;

export type DurableWorkToolName = typeof DURABLE_WORK_TOOL_NAMES[number];

const REPLACE_WORK_PLAN: FunctionToolDefinition = {
  type: "function",
  name: "replace_work_plan",
  description: [
    "Open durable Work for a substantial request, or replace the current Work plan.",
    "Use start_new only when the new request supersedes the current open Work.",
    "Do not use this for simple conversation, stable knowledge, or a single-step read-only lookup.",
    "Use it for multi-source or multi-step research with a synthesized deliverable, even when source tools are read-only.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      start_new: {
        type: "boolean",
        description: "True only when abandoning current open Work and starting unrelated Work.",
        default: false,
      },
      objective: {
        type: "string",
        minLength: 1,
        description: "The concise user-visible outcome this Work must produce.",
      },
      actions: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action_key: {
              type: "string",
              minLength: 1,
              description: "A short semantic key unique within this plan.",
            },
            description: { type: "string", minLength: 1 },
            dependency_keys: {
              type: "array",
              items: { type: "string", minLength: 1 },
              default: [],
            },
            effect: {
              type: "object",
              additionalProperties: false,
              properties: {
                capability: { type: "string", minLength: 1 },
                target: { type: "string", minLength: 1 },
              },
              required: ["capability", "target"],
            },
          },
          required: ["action_key"],
        },
      },
      checks: {
        type: "array",
        items: { type: "string", minLength: 1 },
        default: [],
      },
    },
    required: ["objective", "actions"],
  },
};

const RECORD_WORK_CHECKPOINT: FunctionToolDefinition = {
  type: "function",
  name: "record_work_checkpoint",
  description: [
    "Record a meaningful stage change for current durable Work.",
    "This updates progress and continuation context; it does not authorize tools or block delivery.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      stage: {
        type: "string",
        enum: ["conception", "planning", "execution", "review", "reporting"],
      },
      public_summary: {
        type: "string",
        minLength: 1,
        description: "A short user-visible progress fact without secrets or private paths.",
      },
      next_step: {
        type: "string",
        minLength: 1,
        description: "The next useful action in user-facing language.",
      },
    },
    required: ["stage", "public_summary", "next_step"],
  },
};

const RECORD_WORK_REVIEW: FunctionToolDefinition = {
  type: "function",
  name: "record_work_review",
  description: [
    "Record a concise review of the current Work plan or actual result.",
    "Accepting a result completes Work; revise or partial keeps it open.",
    "A review records judgment but never replaces real tool evidence.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      subject: { type: "string", enum: ["plan", "result"] },
      verdict: { type: "string", enum: ["accept", "revise", "partial"] },
      summary: { type: "string", minLength: 1 },
      corrections: {
        type: "array",
        items: { type: "string", minLength: 1 },
        default: [],
      },
    },
    required: ["subject", "verdict", "summary"],
  },
};

export const DURABLE_WORK_TOOL_DEFINITIONS: readonly FunctionToolDefinition[] =
  Object.freeze([
    REPLACE_WORK_PLAN,
    RECORD_WORK_CHECKPOINT,
    RECORD_WORK_REVIEW,
  ]);

const DURABLE_WORK_TOOL_NAME_SET = new Set<string>(DURABLE_WORK_TOOL_NAMES);

export function isDurableWorkTool(name: string): name is DurableWorkToolName {
  return DURABLE_WORK_TOOL_NAME_SET.has(name);
}
