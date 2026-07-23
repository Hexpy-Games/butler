import {
  READ_OPERATION_RESULT_CAPABILITY,
  type StructuralCapabilityCatalog,
  type StructuralCapabilityDefinition,
} from "../../btcc/index.ts";
import { PRODUCTION_CAPABILITIES } from "./capabilities/index.ts";

const RESULT_READ_CAPABILITY: StructuralCapabilityDefinition = {
  capabilityRef: READ_OPERATION_RESULT_CAPABILITY,
  name: READ_OPERATION_RESULT_CAPABILITY,
  description: [
    "Read an exact byte, line, search, or JSON-pointer view from a prior complete",
    "operation result without rerunning it. JSON pointers address /request for the",
    "durable source operation request, /result for parsed or raw payload, and",
    "/record for canonical result metadata.",
  ].join(" "),
  operationKinds: ["observe"],
  observationScopeKinds: ["result"],
  inputSchema: {
    anyOf: [
      {
        type: "object",
        properties: {
          selector: { type: "string", const: "bytes" },
          start: { type: "integer", minimum: 0 },
          length: { type: "integer", minimum: 1 },
        },
        required: ["selector", "start", "length"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          selector: { type: "string", const: "lines" },
          start_line: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1 },
        },
        required: ["selector", "start_line", "limit"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          selector: { type: "string", const: "search" },
          query: { type: "string", minLength: 1 },
          max_matches: { type: "integer", minimum: 1 },
        },
        required: ["selector", "query", "max_matches"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          selector: { type: "string", const: "json_pointer" },
          pointer: { type: "string" },
        },
        required: ["selector", "pointer"],
        additionalProperties: false,
      },
    ],
  },
};

const PROMOTION_CAPABILITY: StructuralCapabilityDefinition = {
  capabilityRef: "promote_reviewed_candidate",
  name: "promote_reviewed_candidate",
  description: "Atomically promote the exact reviewed candidate under its accepted authorization.",
  operationKinds: ["repository_promotion"],
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

export function createProductionCapabilityCatalog(): StructuralCapabilityCatalog {
  return {
    list: () => [
      ...PRODUCTION_CAPABILITIES,
      RESULT_READ_CAPABILITY,
      PROMOTION_CAPABILITY,
    ],
  };
}
