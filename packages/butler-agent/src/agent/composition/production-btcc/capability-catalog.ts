import type {
  StructuralCapabilityCatalog,
  StructuralCapabilityDefinition,
} from "../../btcc/index.ts";
import { PRODUCTION_CAPABILITIES } from "./capabilities/index.ts";

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
  return { list: () => [...PRODUCTION_CAPABILITIES, PROMOTION_CAPABILITY] };
}
