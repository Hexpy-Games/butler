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
    "Update the current Managed Work action checklist or concise progress summary when no Review is being recorded.",
    "Use it at a meaningful boundary, not to narrate every tool call.",
    "When execution starts or the current action changes, include action_updates that mark the current action active and any completed prior action done; the runtime records exactly the action keys you name.",
    "The runtime checks only known action keys and durable binding; this tool does not choose a Work stage.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
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
    "Optionally record a concise Plan Review, result Review, or whole-Work completion Validation with the current action progress.",
    "Plan and result subjects enter review; completion enters validation against the original request, current Plan, and accepted result Review when those quality records are useful.",
    "The runtime derives the fixed graph transition from subject and verdict; never choose a raw stage.",
    "For a revised or partial result/completion, use correction_scope only to say whether correction belongs in planning or execution.",
    "When an accepted Plan enters execution, mark the first action to execute active in the same call's action_updates.",
    "The runtime validates only the fixed semantic mapping, known action keys, and durable bindings; it does not judge the Review or Validation meaning.",
    "Reviews and completion Validation are optional quality records, never completion blockers. They never change Work to completed; record_work_disposition is the sole closeout and Work-status authority.",
    "Disclosed non-critical limits may still be accepted; partial means a material requested outcome remains unfinished.",
    "A review records judgment but never replaces real tool evidence.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      subject: { type: "string", enum: ["plan", "result", "completion"] },
      verdict: { type: "string", enum: ["accept", "revise", "partial"] },
      correction_scope: {
        type: "string",
        enum: ["planning", "execution"],
        description: [
          "For a revised or partial result/completion, state where correction belongs.",
          "Omit for accepted reviews and for Plan review, whose graph edge is deterministic.",
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

const RECORD_WORK_DISPOSITION: FunctionToolDefinition = {
  type: "function",
  name: "record_work_disposition",
  description: [
    "Atomically declare the explicitly bound Work completed, open, or blocked.",
    "Use this closeout operation when the current Turn has finished its Work update; it does not require Plan, Review, or stage sequence records.",
    "Completed requires every current Plan action done or skipped, no remaining actions, eligible evidence, and no unresolved or in-flight effect.",
    "Open or blocked requires a truthful remaining action or next condition; blocked also requires a concrete next condition.",
    "The Work id must be the exact id from the current bound Work context.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      work_id: {
        type: "string",
        minLength: 1,
        description: "The exact Work id explicitly bound to this Turn.",
      },
      disposition: {
        type: "string",
        enum: ["completed", "open", "blocked"],
      },
      summary: { type: "string", minLength: 1 },
      action_updates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action_key: { type: "string", minLength: 1 },
            status: {
              type: "string",
              enum: ["done", "skipped", "blocked"],
            },
            note: { type: "string", minLength: 1 },
          },
          required: ["action_key", "status"],
        },
        default: [],
      },
      remaining_actions: {
        type: "array",
        items: { type: "string", minLength: 1 },
        default: [],
      },
      next_condition: {
        type: "string",
        minLength: 1,
      },
      followups: {
        type: "array",
        items: { type: "string", minLength: 1 },
        default: [],
      },
    },
    required: ["work_id", "disposition", "summary"],
  },
};

export const DURABLE_WORK_TOOL_DEFINITIONS: readonly FunctionToolDefinition[] =
  Object.freeze([
    START_WORK,
    CONTINUE_WORK,
    REPLACE_WORK_PLAN,
    RECORD_WORK_CHECKPOINT,
    RECORD_WORK_REVIEW,
    RECORD_WORK_DISPOSITION,
  ]);
