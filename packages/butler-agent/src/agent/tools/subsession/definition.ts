import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";

export const delegateToStewardToolDefinition: ButlerToolDefinition = {
  type: "function",
  name: "delegate_to_steward",
  description: [
    "Delegate the exact current accepted managerial Plan to one ordinary Steward session.",
    "The reviewed objective, success criteria, and provenance are loaded from durable Work; the model does not repeat or author them in this call.",
    "Runtime derives delegation identity, inherited Composer access, ordinary tools, workspace, admitted context and EOL, budget, and reviewed provenance.",
    "A safe title is optional presentation metadata; omission uses a fixed privacy-safe title and never copies objective content.",
    "The Steward excludes Butler persona and direct-user presentation prompting, receives the immutable project context and bounded parent conversation projection, and returns one canonical terminal result for synthesis.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      safe_title: { type: "string", minLength: 1, maxLength: 120 },
    },
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
    "The semantic packet is loaded only from the exact current accepted managerial Plan.",
  ],
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
