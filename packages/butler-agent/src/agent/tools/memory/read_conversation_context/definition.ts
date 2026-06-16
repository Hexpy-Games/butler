import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const readConversationContextToolDefinition = {
  type: "function",
  name: "read_conversation_context",
  description: "Read bounded local conversation transcript slices for the active session. Use this to resolve references such as above, earlier, first, that one, or Korean equivalents when compact prompt context is insufficient.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Optional transcript search terms.",
      },
      anchor_event_id: {
        type: "string",
        description: "Optional transcript event id to read around.",
      },
      direction: {
        type: "string",
        enum: [
          "before",
          "after",
          "around",
        ],
        description: "Slice direction relative to query hits or anchor event.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of conversational events to return.",
      },
      max_chars: {
        type: "integer",
        description: "Maximum character budget for returned conversation text.",
      },
    },
    required: [],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const readConversationContextToolMetadata = {
  category: "memory",
  tags: [
    "conversation",
    "transcript",
    "context",
    "reference",
    "대화",
    "이전",
    "위에서",
  ],
  safetyNotes: [
    "Read bounded local transcript slices only; do not dump raw private logs.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
