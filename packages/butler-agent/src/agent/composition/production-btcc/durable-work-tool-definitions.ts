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
    "Choose start_new before updating or executing the current Work; once this Turn continues it, keep the same Work.",
    "Keep objective as the overall multi-Turn user outcome; put the current milestone in actions and checkpoints.",
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
      governing_refs: {
        type: "array",
        items: { type: "string", minLength: 1 },
        default: [],
        description: [
          "A small list of existing governing specification or document references.",
          "Use workspace-relative paths or stable document ids; do not invent references.",
        ].join(" "),
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
              description: [
                "Mark a high-level persistent or external change planned by this action.",
                "For contained workspace and active Project Ledger work, use plain-language capability and outcome; do not enumerate files or invent internal target strings.",
                "An exact external-effect adapter may return ordinary feedback when it needs a more specific capability or logical target.",
              ].join(" "),
              properties: {
                capability: {
                  type: "string",
                  minLength: 1,
                  description: "Plain-language change capability, or an exact tool name when the target boundary requires it.",
                },
                target: {
                  type: "string",
                  minLength: 1,
                  description: "User-meaningful outcome or exact logical target; never include a private absolute path.",
                },
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
    "Update the current Managed Work stage or action checklist when no Review is being recorded.",
    "Use it at a meaningful boundary, not to narrate every tool call.",
    "The runtime checks only the small legal stage transition and known action keys.",
    "If a transition is rejected, use the returned allowed next stages; useful work and final delivery remain valid.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      next_stage: {
        type: "string",
        enum: ["conception", "planning", "execution", "review", "reporting"],
        description: "The stage to enter. Omit when only updating action progress.",
      },
      action_updates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action_key: { type: "string", minLength: 1 },
            status: {
              type: "string",
              enum: ["pending", "active", "done", "blocked", "skipped"],
            },
            note: { type: "string", minLength: 1 },
          },
          required: ["action_key", "status"],
        },
        default: [],
      },
      public_summary: {
        type: "string",
        minLength: 1,
        description: "Optional short user-visible progress fact without secrets or private paths.",
      },
      next_step: {
        type: "string",
        minLength: 1,
        description: "Optional next useful action in user-facing language.",
      },
    },
  },
};

const RECORD_WORK_REVIEW: FunctionToolDefinition = {
  type: "function",
  name: "record_work_review",
  description: [
    "Record a concise review of the current Work plan or actual result, together with the stage and action progress known at that Review.",
    "The call enters review; include action_updates known at that point and next_stage only when work should continue to planning, execution, or reporting after the Review.",
    "The runtime validates only the existing transitions into and out of review plus known action keys; it does not judge the Review's meaning.",
    "Accepting a result completes Work only after every current action is done or skipped; otherwise the Review is kept and Work remains open.",
    "Judge against the original user request: disclosed non-critical limits may still be accepted; partial means a material requested outcome remains unfinished.",
    "A review records judgment but never replaces real tool evidence.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      subject: { type: "string", enum: ["plan", "result"] },
      verdict: { type: "string", enum: ["accept", "revise", "partial"] },
      next_stage: {
        type: "string",
        enum: ["planning", "execution", "reporting"],
        description: "The legal stage to enter after the Review. Omit to remain in review.",
      },
      action_updates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action_key: { type: "string", minLength: 1 },
            status: {
              type: "string",
              enum: ["pending", "active", "done", "blocked", "skipped"],
            },
            note: { type: "string", minLength: 1 },
          },
          required: ["action_key", "status"],
        },
        default: [],
      },
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
