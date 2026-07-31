import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const readConversationContextToolDefinition = {
  type: "function",
  name: "read_conversation_context",
  description: "Read bounded canonical conversation context for the active session. Use this to resolve references such as above, earlier, first, that one, or Korean equivalents when compact prompt context is insufficient.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Optional canonical conversation search terms.",
      },
      anchor_message_id: {
        type: "string",
        description: "Optional canonical conversation_message_id to read around.",
      },
      anchor_event_id: {
        type: "string",
        description: "Legacy event id to map to a canonical conversation_message_id before reading around.",
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
        description: "Maximum number of canonical conversation messages to return.",
      },
      max_chars: {
        type: "integer",
        description: "Maximum character budget for returned conversation text.",
      },
      include_tools: {
        type: "boolean",
        description: "Include canonical tool call/result parts when the referenced context depends on tool adjacency.",
      },
    },
    required: [],
  },
  effectBoundary: "none",
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const readConversationContextToolMetadata = {
  category: "memory",
  tags: [
    "conversation",
    "canonical",
    "context",
    "reference",
    "대화",
    "이전",
    "위에서",
  ],
  safetyNotes: [
    "Read bounded canonical conversation messages only; do not dump raw private logs.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
