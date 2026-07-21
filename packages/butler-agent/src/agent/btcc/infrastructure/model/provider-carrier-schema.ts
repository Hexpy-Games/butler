import type { AvailablePhaseCapability } from "./contracts.ts";
import type { ProviderCarrierFunction } from "./contracts.ts";

export function providerCarrierSchema(
  capabilities: readonly AvailablePhaseCapability[],
  submissionSchema: Record<string, unknown>,
): Record<string, unknown> {
  const carrierVariants = [phaseSubmissionSchema(submissionSchema)];
  if (capabilities.length > 0) {
    carrierVariants.push(operationRequestsSchema(capabilities));
  }
  return { type: "object", anyOf: carrierVariants };
}

export function providerCarrierFunctions(
  capabilities: readonly AvailablePhaseCapability[],
  submissionSchema: Record<string, unknown>,
): ProviderCarrierFunction[] {
  const functions: ProviderCarrierFunction[] = [{
    name: "submit_btcc_phase_submission",
    description: "Submit the one phase product allowed by the current BTCC phase.",
    carrierKind: "phase_submission",
    parameters: objectParameters({ submission: submissionSchema }, ["submission"]),
  }];
  if (capabilities.length > 0) {
    const requests = operationRequestsSchema(capabilities).properties as Record<string, unknown>;
    functions.push({
      name: "submit_btcc_operation_requests",
      description: "Request one or more operations allowed by the current BTCC phase.",
      carrierKind: "operation_requests",
      parameters: objectParameters({ requests: requests.requests }, ["requests"]),
    });
  }
  return functions;
}

function phaseSubmissionSchema(submissionSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    properties: {
      kind: stringConstant("phase_submission"),
      submission: submissionSchema,
    },
    required: ["kind", "submission"],
    additionalProperties: false,
  };
}

function operationRequestsSchema(
  capabilities: readonly AvailablePhaseCapability[],
): Record<string, unknown> {
  return {
    properties: {
      kind: stringConstant("operation_requests"),
      requests: {
        type: "array",
        minItems: 1,
        items: { anyOf: capabilities.map(operationSchema) },
      },
    },
    required: ["kind", "requests"],
    additionalProperties: false,
  };
}

function operationSchema(
  capability: AvailablePhaseCapability,
): Record<string, unknown> {
  const common = {
    capabilityRef: stringConstant(capability.capabilityRef),
    input: capability.inputSchema,
  };
  switch (capability.operationKind) {
    case "observe":
      return operationShape("observe", {
        ...common,
        scopeRef: { type: "string", enum: capability.observationScopeRefs },
      });
    case "workspace_artifact_action":
      return operationShape("workspace_artifact_action", {
        ...common,
        relativeTarget: { type: "string" },
      });
    case "review_validation":
      return operationShape("review_validation", {
        ...common,
      });
    case "repository_promotion":
      return operationShape("repository_promotion", {
        ...common,
      });
  }
}

function operationShape(
  kind: string,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      requestId: { type: "string" },
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
