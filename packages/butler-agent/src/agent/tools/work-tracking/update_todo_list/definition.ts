import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const updateTodoListToolDefinition = {
  type: "function",
  name: "update_todo_list",
  description: "Create or replace Butler's durable checklist for the current non-trivial multi-step work. Reuse stable ids across updates; Butler preserves retained order and appends new ids. Keep at most one item in_progress.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      list_id: {
        type: "string",
        description: "Safe list id. Defaults to main.",
      },
      title: {
        type: "string",
        description: "Optional user-facing checklist title.",
      },
      todos: {
        type: "array",
        description: "Full current todo list. The first accepted order is durable; later array reordering does not move retained ids, and new ids append.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              description: "Stable safe id. Reuse the returned id on every later update; Butler assigns one when omitted initially.",
            },
            content: {
              type: "string",
              description: "Imperative form, e.g. Run validation.",
            },
            active_form: {
              type: "string",
              description: "Present continuous form, e.g. Running validation.",
            },
            status: {
              type: "string",
              enum: [
                "pending",
                "in_progress",
                "completed",
                "cancelled",
              ],
            },
            phase: {
              type: "string",
              enum: [
                "conception",
                "planning",
                "execution",
                "review",
                "consolidation",
                "reporting",
              ],
              description: "Optional Butler Turn Cognition Cycle phase for this step.",
            },
            priority: {
              type: "string",
              enum: [
                "low",
                "normal",
                "high",
              ],
            },
            blocked_by: {
              type: "array",
              items: {
                type: "string",
              },
            },
            note: {
              type: "string",
            },
          },
          required: [
            "content",
            "active_form",
            "status",
          ],
        },
      },
    },
    required: [
      "todos",
    ],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const updateTodoListToolMetadata = {
  category: "todo",
  tags: [
    "todo",
    "plan",
    "progress",
    "checklist",
  ],
  safetyNotes: [
    "Use for non-trivial multi-step work, not simple chat answers.",
  ],
} satisfies ToolCapabilityMetadata;
