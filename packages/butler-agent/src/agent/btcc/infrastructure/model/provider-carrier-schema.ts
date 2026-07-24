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
    parameters: objectParameters({
      submission: submissionSchema,
      publicActivity: publicActivitySchema("phase handoff"),
    }, ["submission", "publicActivity"]),
  }];
  if (capabilities.length > 0) {
    const carrier = operationRequestsSchema(
      capabilities,
      authority,
    ).properties as Record<string, unknown>;
    functions.push({
      name: "submit_btcc_operation_requests",
      description: [
        "Request one coherent batch of operations allowed by the current BTCC phase.",
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
