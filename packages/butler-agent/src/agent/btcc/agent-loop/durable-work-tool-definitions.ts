import type { FunctionToolDefinition } from
  "../../../integrations/providers/runtime-contracts.ts";

const START_WORK: FunctionToolDefinition = {
  type: "function",
  name: "start_work",
  description: [
    "Explicitly start unrelated durable Work and bind this Turn to it.",
    "Use this before dependent tools or Plan changes when the current request is new Work.",
    "Ordinary tools never select Work automatically.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      objective: {
        type: "string",
        minLength: 1,
        description: "The concise stable user-visible outcome for the new Work.",
      },
    },
    required: ["objective"],
  },
};

const CONTINUE_WORK: FunctionToolDefinition = {
  type: "function",
  name: "continue_work",
  description: [
    "Explicitly bind this Turn to the exact current open Work shown in context.",
    "Use only when the current request continues that Work; ordinary tools never select it.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      work_id: {
        type: "string",
        minLength: 1,
        description: "The exact candidate Work id returned in the current Work context.",
      },
    },
    required: ["work_id"],
  },
};

const REPLACE_WORK_PLAN: FunctionToolDefinition = {
  type: "function",
  name: "replace_work_plan",
  description: [
    "Open or revise the Plan for the Work explicitly selected by start_work or continue_work.",
    "Use start_new only as a compatibility translation when older callers cannot use start_work.",
    "Ordinary tools never select Work; choose start_work or continue_work before this Plan operation.",
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
              description: "The concise stable user-visible action summary used for future progress updates, dependencies, and model continuation. Name the concrete action or outcome in the user's language, not a generic stage word.",
            },
            description: {
              type: "string",
              minLength: 1,
              description: "Optional fuller detail for the action. Omit it when action_key already states the complete intended action clearly.",
            },
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
    "When execution starts or the current action changes, include action_updates that mark the current action active and any completed prior action done; the runtime records exactly the action keys you name.",
    "The runtime checks only the small legal stage transition and known action keys.",
    "If a transition is rejected, use the returned allowed next stages; useful work and final delivery remain valid.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      next_stage: {
        type: "string",
        enum: [
          "conception",
          "planning",
          "execution",
          "review",
          "validation",
          "reporting",
        ],
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
    "Record a concise Plan Review, result Review, or whole-Work completion Validation with the current action progress.",
    "Plan and result subjects enter review; completion enters validation against the original request, current Plan, and accepted result Review.",
    "Include action_updates known at that point and next_stage only when taking one legal next step after the entered stage.",
    "When an accepted Plan enters execution, mark the first action to execute active in the same call's action_updates.",
    "The runtime validates only fixed stage transitions, known action keys, and durable bindings; it does not judge the Review or Validation meaning.",
    "Accepting a result never completes Work. A completion acceptance can complete Work only after the current Plan and result Reviews are accepted, every action is done or skipped, and no effect blocker remains.",
    "Disclosed non-critical limits may still be accepted; partial means a material requested outcome remains unfinished.",
    "A review records judgment but never replaces real tool evidence.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      subject: { type: "string", enum: ["plan", "result", "completion"] },
      verdict: { type: "string", enum: ["accept", "revise", "partial"] },
      next_stage: {
        type: "string",
        enum: ["planning", "execution", "review", "validation", "reporting"],
        description: [
          "The legal stage to enter after Review or Validation.",
          "Omit to remain in the stage entered by this call.",
        ].join(" "),
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
    START_WORK,
    CONTINUE_WORK,
    REPLACE_WORK_PLAN,
    RECORD_WORK_CHECKPOINT,
    RECORD_WORK_REVIEW,
  ]);
