import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const listSkillsToolDefinition = {
  type: "function",
  name: "list_skills",
  description: "List Butler's machine-readable strategy skills, applicability notes, allowed tools, dispatch preference, review requirement, and validation issues.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {},
    required: [],
  },
  effectBoundary: "none",
  concurrencySafe: true,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const listSkillsToolMetadata = {
  category: "skill",
  tags: [
    "skills",
    "strategy",
    "catalog",
  ],
  safetyNotes: [
    "Lists strategy skills, not executable tools.",
  ],
  satisfiesCompletionObligations: [
    "source_verified",
  ],
} satisfies ToolCapabilityMetadata;
