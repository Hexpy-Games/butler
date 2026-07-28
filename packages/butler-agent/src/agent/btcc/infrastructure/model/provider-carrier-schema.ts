import type {
  AvailablePhaseCapability,
  ProviderCapabilityVocabularyEntry,
  ProviderCarrierFunction,
} from "./contracts.ts";
import type { OperationAuthority } from "../../core/index.ts";

export function providerCarrierSchema(
  capabilities: readonly ProviderCapabilityVocabularyEntry[],
  submissionSchema: Record<string, unknown>,
): Record<string, unknown> {
  const carrierVariants = [phaseSubmissionSchema(submissionSchema)];
  if (capabilities.length > 0) {
    carrierVariants.push(operationRequestsSchema(capabilities, { kind: "vocabulary" }));
  }
  return { anyOf: carrierVariants };
}

export function providerCarrierAdmissionSchema(
  vocabulary: readonly ProviderCapabilityVocabularyEntry[],
  available: readonly AvailablePhaseCapability[],
  submissionSchema: Record<string, unknown>,
  authority: OperationAuthority,
): Record<string, unknown> {
  const carrierVariants = [phaseSubmissionSchema(submissionSchema)];
  const capabilities = admissionCapabilities(vocabulary, available);
  if (capabilities.length > 0) {
    carrierVariants.push(operationRequestsSchema(capabilities, { kind: "exact", authority }));
  }
  return { anyOf: carrierVariants };
}

function admissionCapabilities(
  vocabulary: readonly ProviderCapabilityVocabularyEntry[],
  available: readonly AvailablePhaseCapability[],
): CarrierCapability[] {
  return [
    ...available.filter((capability) => capability.operationKind === "observe"),
    ...vocabulary.filter((capability) => capability.operationKind !== "observe"),
  ];
}

export function providerCarrierFunctions(
  capabilities: readonly ProviderCapabilityVocabularyEntry[],
  submissionSchema: Record<string, unknown>,
): ProviderCarrierFunction[] {
  const functions = phaseSubmissionFunctions(submissionSchema);
  if (capabilities.length > 0) {
    const carrier = operationRequestsSchema(
      capabilities,
      { kind: "vocabulary" },
    ).properties as Record<string, unknown>;
    functions.push({
      name: "submit_btcc_operation_requests",
      description: [
        "Propose one coherent batch from the stable BTCC operation vocabulary.",
        "Choose only operation-kind and capability pairs listed in the current capabilitySchemas.",
        "For observe, include one required scopeRef from that capability's observationScopeRefs.",
        "Runtime binds mutation authority identities and admits the exact current scope.",
        "Include every currently known independent operation needed for the next decision.",
      ].join(" "),
      carrierKind: "operation_requests",
      parameters: objectParameters({
        phaseContinuity: carrier.phaseContinuity,
        requests: carrier.requests,
      }, ["phaseContinuity", "requests"]),
    });
  }
  return functions;
}

function phaseSubmissionFunctions(
  submissionSchema: Record<string, unknown>,
): ProviderCarrierFunction[] {
  return leafObjectVariants(submissionSchema).map((variant, index) => {
    const properties = objectValue(variant.properties);
    if (!properties || "publicActivity" in properties) {
      throw new Error("Phase submission function requires an object without publicActivity");
    }
    return {
      name: `submit_btcc_phase_${variantLabel(properties, index)}`,
      description: "Submit one explicit BTCC phase carrier allowed by the current phase.",
      carrierKind: "phase_submission",
      parameters: objectParameters({
        submission: variant,
        publicActivity: publicActivitySchema("phase handoff"),
      }, ["submission", "publicActivity"]),
    };
  });
}

function leafObjectVariants(schema: Record<string, unknown>): Record<string, unknown>[] {
  const variants = Array.isArray(schema.anyOf) ? schema.anyOf : null;
  if (variants && !objectValue(schema.properties)) {
    return variants.flatMap((variant) => {
      const record = objectValue(variant);
      if (!record) throw new Error("Phase submission variant must be an object schema");
      return leafObjectVariants(record);
    });
  }
  if (schema.type !== "object" || !objectValue(schema.properties)) {
    throw new Error("Phase submission must resolve to object schema variants");
  }
  return [schema];
}

function variantLabel(properties: Record<string, unknown>, index: number): string {
  const constants = ["kind", "verdict"]
    .map((key) => objectValue(properties[key])?.const)
    .filter((value): value is string => typeof value === "string");
  const label = constants.join("_").replace(/[^a-zA-Z0-9_]/g, "_");
  return `${label || "submission"}_${index + 1}`;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function phaseSubmissionSchema(submissionSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      kind: stringConstant("phase_submission"),
      submission: submissionSchema,
      publicActivity: publicActivitySchema("phase handoff"),
    },
    required: ["kind", "submission", "publicActivity"],
    additionalProperties: false,
  };
}

function operationRequestsSchema(
  capabilities: readonly CarrierCapability[],
  binding: CarrierSchemaBinding,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      kind: stringConstant("operation_requests"),
      phaseContinuity: phaseContinuitySchema(),
      requests: {
        type: "array",
        minItems: 1,
        items: { anyOf: capabilities.map((capability) => operationSchema(capability, binding)) },
      },
    },
    required: ["kind", "phaseContinuity", "requests"],
    additionalProperties: false,
  };
}

function phaseContinuitySchema(): Record<string, unknown> {
  return {
    ...objectParameters({
    objectiveState: { type: "string" },
    decisions: { type: "array", items: { type: "string" } },
    unresolved: { type: "array", items: { type: "string" } },
    nextOperationPurpose: { type: "string" },
    publicActivity: publicActivitySchema("operation batch now beginning"),
    }, [
      "objectiveState",
      "decisions",
      "unresolved",
      "nextOperationPurpose",
      "publicActivity",
    ]),
    description: [
      "Replaceable phase-local continuity for the next stateless model round.",
      "Integrate conclusions, not raw operation output or a growing transcript.",
    ].join(" "),
  };
}

function publicActivitySchema(moment: string): Record<string, unknown> {
  return {
    ...objectParameters({
      summary: { type: "string", minLength: 1 },
      rationale: { type: "string", minLength: 1 },
      nextStep: { type: "string", minLength: 1 },
    }, ["summary", "rationale", "nextStep"]),
    description: [
      `User-visible activity record for the ${moment}.`,
      "Name the concrete target and current action, decision, or result.",
      "Explain why it matters to the accepted Goal, governing Spec, Plan, or current review finding.",
      "Name the next observable action or state transition.",
      "Do not merely repeat the current phase name.",
      "Summarize intent without exposing hidden chain-of-thought.",
    ].join(" "),
  };
}

function operationSchema(
  capability: CarrierCapability,
  binding: CarrierSchemaBinding,
): Record<string, unknown> {
  const common = {
    publicTitle: {
      type: "string",
      minLength: 1,
      maxLength: 120,
      description: "Concise model-authored user-visible operation title.",
    },
    capabilityRef: stringConstant(capability.capabilityRef),
    input: capability.inputSchema,
  };
  switch (capability.operationKind) {
    case "observe":
      return operationShape("observe", {
        ...common,
        scopeRef: binding.kind === "exact"
          ? {
              type: "string",
              enum: exactObservationScopes(capability),
              description: "Required semantic target selected from this capability's admitted observationScopeRefs.",
            }
          : {
              type: "string",
              minLength: 1,
              description: "Required semantic target selected from the current capabilitySchemas observationScopeRefs.",
            },
      });
    case "workspace_artifact_action":
      return operationShape("workspace_artifact_action", {
        ...common,
        relativeTarget: { type: "string", minLength: 1 },
      });
    case "workspace_artifact_observation":
      return operationShape("workspace_artifact_observation", common);
    case "review_validation":
      return operationShape("review_validation", {
        ...common,
      });
    case "turn_local_effect":
      return operationShape("turn_local_effect", common);
    case "external_effect":
      return operationShape("external_effect", {
        ...common,
      });
    case "repository_promotion":
      return operationShape("repository_promotion", {
        ...common,
      });
  }
}

type CarrierCapability = AvailablePhaseCapability | ProviderCapabilityVocabularyEntry;

type CarrierSchemaBinding =
  | { kind: "vocabulary" }
  | { kind: "exact"; authority: OperationAuthority };

function exactObservationScopes(capability: CarrierCapability): readonly string[] {
  if (!("observationScopeRefs" in capability)) {
    throw new Error("Exact carrier admission requires bound observation scopes");
  }
  return capability.observationScopeRefs;
}

function operationShape(
  kind: string,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      requestId: {
        type: "string",
        minLength: 1,
        maxLength: 96,
        pattern: "^[A-Za-z0-9_.:/-]+$",
      },
      kind: stringConstant(kind),
      ...properties,
    },
    required: ["requestId", "kind", ...Object.keys(properties)],
    additionalProperties: false,
  };
}

function stringConstant(value: string): Record<string, unknown> {
  return { type: "string", const: value };
}

function objectParameters(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}
