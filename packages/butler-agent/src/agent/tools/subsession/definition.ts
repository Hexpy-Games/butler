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
    "Delegate one bounded effect-free inspection or iterative mutation Work to exactly one ordinary Steward session.",
    "Provide the execution mode, minimal task packet, acceptance criteria, allowed native surface, and mutation scope for mutation only.",
    "For read_only, allowed_tools_and_effects is exactly the complete five-value array [grep_files:workspace, list_files:workspace, read_file:workspace, web_read:network, web_search:network], and mutation_scope is [].",
    "Every mutation Steward can list, grep, read, apply admitted edit/write effects, and run bounded workspace validation through the ordinary BTCC loop.",
    "For mutation, allowed_tools_and_effects may contain edit_file:workspace, write_file:workspace, and run_command:workspace; mutation_scope must contain exact relative files or directory prefixes; terminal dir/** shorthand is canonicalized to dir/, while root or embedded wildcards remain forbidden.",
    "The Steward receives bounded delegated context instead of Butler persona/transcript and returns one canonical terminal result for synthesis.",
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
    "The delegated packet bounds authority and context; it does not replace the ordinary BTCC Work lifecycle.",
  ],
};
