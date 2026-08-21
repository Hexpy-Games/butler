import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";
import {
  SUBSESSION_ALLOWED_TOOLS_AND_EFFECTS,
  SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS,
} from "../../btcc/subsessions/scope.ts";

const SUBSESSION_EFFECT_VALUES = [
  ...SUBSESSION_ALLOWED_TOOLS_AND_EFFECTS,
  ...SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS,
] as const;

export const delegateToStewardToolDefinition: ButlerToolDefinition = {
  type: "function",
  name: "delegate_to_steward",
  description: [
    "Delegate one bounded mutation or effect-free inspection to exactly one ordinary Steward session.",
    "Provide the execution mode, minimal task packet, acceptance criteria, allowed native surface, and mutation scope for mutation only.",
    "For read_only, allowed_tools_and_effects is exactly the complete five-value array [grep_files:workspace, list_files:workspace, read_file:workspace, web_read:network, web_search:network], and mutation_scope is [].",
    "Every mutation Steward can safely list, grep, and read the isolated worktree before applying an admitted effect.",
    "For mutation, allowed_tools_and_effects may contain only edit_file:workspace or write_file:workspace, and mutation_scope must contain exact relative files or directory prefixes; terminal dir/** shorthand is canonicalized to dir/, while root or embedded wildcards remain forbidden.",
    "The Steward receives no Butler persona or transcript and reports one success result for synthesis.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      execution_mode: { type: "string", enum: ["read_only", "mutation"] },
      safe_title: { type: "string", minLength: 1, maxLength: 120 },
      objective: { type: "string", minLength: 1, maxLength: 800 },
      acceptance_criteria: { type: "array", minItems: 1, items: { type: "string", minLength: 1, maxLength: 240 } },
      task_or_plan_refs: { type: "array", items: { type: "string", minLength: 1, maxLength: 240 } },
      constraints_and_non_goals: { type: "array", minItems: 1, items: { type: "string", minLength: 1, maxLength: 240 } },
      allowed_tools_and_effects: {
        type: "array",
        minItems: 1,
        items: { type: "string", enum: SUBSESSION_EFFECT_VALUES, minLength: 1, maxLength: 240 },
      },
      mutation_scope: { type: "array", items: { type: "string", minLength: 1, maxLength: 240 } },
    },
    required: [
      "execution_mode",
      "safe_title",
      "objective",
      "acceptance_criteria",
      "task_or_plan_refs",
      "constraints_and_non_goals",
      "allowed_tools_and_effects",
      "mutation_scope",
    ],
    oneOf: [
      {
        properties: {
          execution_mode: { const: "read_only" },
          allowed_tools_and_effects: {
            type: "array",
            minItems: SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS.length,
            maxItems: SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS.length,
            uniqueItems: true,
            items: { type: "string", enum: SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS },
          },
          mutation_scope: { type: "array", maxItems: 0 },
        },
      },
      {
        properties: {
          execution_mode: { const: "mutation" },
          allowed_tools_and_effects: {
            type: "array",
            minItems: 1,
            items: { type: "string", enum: SUBSESSION_ALLOWED_TOOLS_AND_EFFECTS },
          },
          mutation_scope: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              minLength: 1,
              maxLength: 240,
              description: "Exact relative file, directory prefix, or terminal dir/** shorthand. Other wildcards are forbidden.",
            },
          },
        },
      },
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
    "Mutation uses a validated session-owned isolated worktree; read-only inspection uses only the validated project workspace.",
  ],
};
