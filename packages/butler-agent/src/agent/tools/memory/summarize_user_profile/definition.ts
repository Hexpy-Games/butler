import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const summarizeUserProfileToolDefinition = {
  type: "function",
  name: "summarize_user_profile",
  description: "Return Butler's reflective understanding of the principal from the consent-gated profile black box. Use when the user asks how Butler understands them. Does not expose raw profile internals.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      locale: {
        type: "string",
        enum: [
          "en",
          "ko",
        ],
        description: "Language for the reflective summary.",
      },
    },
    required: [],
  },
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const summarizeUserProfileToolMetadata = {
  category: "memory",
  tags: [
    "profile",
    "personalization",
    "reflection",
    "user",
    "프로필",
    "개인화",
    "사용자",
  ],
  safetyNotes: [
    "Returns a reflective summary only; it never exposes raw profile tables, candidates, or private evidence.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
