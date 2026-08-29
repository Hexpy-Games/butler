import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const delegateToStewardToolDefinition: ButlerToolDefinition = {
  type: "function",
  name: "delegate_to_steward",
  description: [
    "Delegate one complete Butler-authored request to an ordinary Steward session.",
    "Write the complete request exactly as the Steward should receive it; runtime preserves it unchanged instead of reconstructing it from Work or Plan state.",
    "Runtime derives delegation identity, inherited Composer access, ordinary tools, workspace, admitted context and EOL, budget, and reviewed provenance.",
    "A safe title is optional presentation metadata; omission uses a fixed privacy-safe title and never copies objective content.",
    "The Steward excludes Butler persona and direct-user presentation prompting, receives the immutable project context and bounded parent conversation projection, and returns one canonical terminal result for synthesis.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      request: { type: "string", minLength: 1, maxLength: 8000 },
      safe_title: { type: "string", minLength: 1, maxLength: 120 },
    },
    required: ["request"],
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
    "Runtime derives workspace and ordinary tools from the admitted parent Turn; Composer access remains the sole authority.",
    "The semantic request is copied unchanged from the Butler tool call.",
  ],
};

export const delegateToWorkerToolDefinition: ButlerToolDefinition = {
  type: "function",
  name: "delegate_to_worker",
  description: "Assign one bounded action from the current accepted Steward Plan to a Worker. Steward remains responsible for integration, review, validation, and reporting.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      objective: { type: "string", minLength: 1, maxLength: 2000 },
      acceptance_criteria: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 500 },
        maxItems: 8,
      },
      safe_title: { type: "string", minLength: 1, maxLength: 120 },
      profile_id: { type: "string", minLength: 1, maxLength: 48 },
    },
    required: ["objective", "acceptance_criteria"],
  },
  effectBoundary: "turn_local",
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
};

export const delegateToWorkerToolMetadata: ToolCapabilityMetadata = {
  category: "dispatch",
  tags: ["subsession", "worker", "delegation"],
  safetyNotes: ["Worker executes one bounded Task and reports only to Steward."],
};

export const steerStewardToolDefinition: ButlerToolDefinition = {
  type: "function",
  name: "steer_steward",
  description: "Send a bounded correction or added instruction to one active Steward relation. Continue the same relation and Work; never create a replacement delegation. Provide relation_id when more than one Steward is active.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      instruction: { type: "string", minLength: 1, maxLength: 1200 },
      relation_id: { type: "string", minLength: 1, maxLength: 160 },
      safe_title: { type: "string", minLength: 1, maxLength: 120 },
    },
    required: ["instruction"],
  },
  effectBoundary: "turn_local",
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
};

export const steerStewardToolMetadata: ToolCapabilityMetadata = {
  category: "dispatch",
  tags: ["subsession", "steward", "direction"],
  safetyNotes: ["Persists one addressed direction and applies it only at the active Steward's next safe model boundary."],
};

export const cancelStewardToolDefinition: ButlerToolDefinition = {
  type: "function",
  name: "cancel_steward",
  description: "Stop one active Steward relation through the existing durable cancel_turn queue. Provide relation_id when more than one Steward is active.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      relation_id: { type: "string", minLength: 1, maxLength: 160 },
      safe_title: { type: "string", minLength: 1, maxLength: 120 },
    },
  },
  effectBoundary: "turn_local",
  concurrencySafe: false,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
};

export const cancelStewardToolMetadata: ToolCapabilityMetadata = {
  category: "dispatch",
  tags: ["subsession", "steward", "cancel"],
  safetyNotes: ["Targets one exact active relation and reuses the canonical durable Turn cancellation path."],
};
