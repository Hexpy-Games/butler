import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const requestPrincipalDecisionToolDefinition = {
  type: "function",
  name: "request_principal_decision",
  description: "Pause a planned task only for a critical decision that belongs to the principal, with Butler's recommendation and concrete options.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      task_id: {
        type: "string",
        description: "Planned task id to pause.",
      },
      situation: {
        type: "string",
        description: "Critical decision situation.",
      },
      recommended_option_id: {
        type: "string",
        description: "Butler's recommended option id.",
      },
      options: {
        type: "array",
        description: "Concrete options the principal can choose.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
            },
            label: {
              type: "string",
            },
            description: {
              type: "string",
            },
          },
          required: [
            "id",
            "label",
            "description",
          ],
        },
      },
      tradeoffs: {
        type: "array",
        description: "Important tradeoffs behind the options.",
        items: {
          type: "string",
        },
      },
      expires_at: {
        type: "string",
        description: "Optional ISO timestamp for decision expiry.",
      },
    },
    required: [
      "task_id",
      "situation",
      "recommended_option_id",
      "options",
    ],
  },
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const requestPrincipalDecisionToolMetadata = {
  category: "control",
  tags: [
    "decision",
    "principal",
    "approval",
    "choice",
  ],
  safetyNotes: [
    "Use only for critical tradeoffs; include a recommendation.",
  ],
} satisfies ToolCapabilityMetadata;
