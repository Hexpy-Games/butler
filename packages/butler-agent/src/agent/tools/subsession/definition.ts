import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const delegateToStewardToolDefinition: ButlerToolDefinition = {
  type: "function",
  name: "delegate_to_steward",
  description: [
    "Delegate one bounded mutation to exactly one ordinary Steward session.",
    "Provide a minimal task packet, acceptance criteria, allowed effects, and mutation scope.",
    "The Steward receives no Butler persona or transcript and reports one success result for synthesis.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      safe_title: { type: "string", minLength: 1, maxLength: 120 },
      objective: { type: "string", minLength: 1, maxLength: 800 },
      acceptance_criteria: { type: "array", minItems: 1, items: { type: "string", minLength: 1, maxLength: 240 } },
      task_or_plan_refs: { type: "array", items: { type: "string", minLength: 1, maxLength: 240 } },
      constraints_and_non_goals: { type: "array", minItems: 1, items: { type: "string", minLength: 1, maxLength: 240 } },
      allowed_tools_and_effects: { type: "array", minItems: 1, items: { type: "string", minLength: 1, maxLength: 240 } },
      mutation_scope: { type: "array", minItems: 1, items: { type: "string", minLength: 1, maxLength: 240 } },
    },
    required: [
      "safe_title",
      "objective",
      "acceptance_criteria",
      "task_or_plan_refs",
      "constraints_and_non_goals",
      "allowed_tools_and_effects",
      "mutation_scope",
    ],
  },
  effectBoundary: "turn_local",
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
};

export const delegateToStewardToolMetadata: ToolCapabilityMetadata = {
  category: "dispatch",
  tags: ["subsession", "steward", "delegation"],
  safetyNotes: [
    "Creates one ordinary Steward session with one immutable minimal packet.",
    "The Steward mutation is constrained to a validated session-owned isolated worktree.",
  ],
};
