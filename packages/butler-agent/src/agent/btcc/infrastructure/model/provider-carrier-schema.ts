import type { AvailablePhaseCapability } from "./contracts.ts";
import type { ProviderCarrierFunction } from "./contracts.ts";
import type { OperationAuthority } from "../../core/index.ts";

export function providerCarrierSchema(
  capabilities: readonly AvailablePhaseCapability[],
  submissionSchema: Record<string, unknown>,
  authority: OperationAuthority,
): Record<string, unknown> {
  const carrierVariants = [phaseSubmissionSchema(submissionSchema)];
  if (capabilities.length > 0) {
    carrierVariants.push(operationRequestsSchema(capabilities, authority));
  }
  return { anyOf: carrierVariants };
}

export function providerCarrierAdmissionSchema(
  capabilities: readonly AvailablePhaseCapability[],
  submissionSchema: Record<string, unknown>,
): Record<string, unknown> {
  const carrierVariants = [phaseSubmissionSchema(submissionSchema)];
  if (capabilities.length > 0) {
    carrierVariants.push(operationRequestsSchema(capabilities));
  }
  return { anyOf: carrierVariants };
}

export function providerCarrierFunctions(
  capabilities: readonly AvailablePhaseCapability[],
  submissionSchema: Record<string, unknown>,
  authority: OperationAuthority,
): ProviderCarrierFunction[] {
  const functions: ProviderCarrierFunction[] = [{
    name: "submit_btcc_phase_submission",
    description: "Submit the one phase product allowed by the current BTCC phase.",
    carrierKind: "phase_submission",
    parameters: objectParameters({ submission: submissionSchema }, ["submission"]),
  }];
  if (capabilities.length > 0) {
    const carrier = operationRequestsSchema(
      capabilities,
      authority,
    ).properties as Record<string, unknown>;
    functions.push({
      name: "submit_btcc_operation_requests",
      description: "Request one or more operations allowed by the current BTCC phase.",
      carrierKind: "operation_requests",
      parameters: objectParameters({
        phaseContinuity: carrier.phaseContinuity,
        requests: carrier.requests,
      }, ["phaseContinuity", "requests"]),
    });
  }
  return functions;
}

function phaseSubmissionSchema(submissionSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
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
  authority?: OperationAuthority,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      kind: stringConstant("operation_requests"),
      phaseContinuity: phaseContinuitySchema(),
      requests: {
        type: "array",
        minItems: 1,
        items: { anyOf: capabilities.map((capability) => operationSchema(capability, authority)) },
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
    }, ["objectiveState", "decisions", "unresolved", "nextOperationPurpose"]),
    description: [
      "Replaceable phase-local continuity for the next stateless model round.",
      "Integrate conclusions, not raw operation output or a growing transcript.",
    ].join(" "),
  };
}

function operationSchema(
  capability: AvailablePhaseCapability,
  authority?: OperationAuthority,
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
        relativeTarget: authority
          ? { type: "string", enum: workspaceTargets(authority) }
          : { type: "string" },
      });
    case "workspace_artifact_observation":
      return operationShape("workspace_artifact_observation", common);
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

function workspaceTargets(authority: OperationAuthority): string[] {
  if (authority.mutation.kind !== "workspace_only") return [];
  if (authority.mutation.operationRoot.kind === "file") {
    return [authority.mutation.operationRoot.relativeTarget];
  }
  return authority.mutation.mutationScope.kind === "contained_paths"
    ? authority.mutation.mutationScope.writablePaths
    : [authority.mutation.operationRoot.relativeTarget];
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
