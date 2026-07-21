import type { OperationAuthority } from "../../core/index.ts";
import type { AvailablePhaseCapability } from "./contracts.ts";

export function providerCarrierSchema(
  capabilities: readonly AvailablePhaseCapability[],
  authority: OperationAuthority,
  submissionSchema: Record<string, unknown>,
): Record<string, unknown> {
  const carrierVariants = [phaseSubmissionSchema(submissionSchema)];
  if (capabilities.length > 0) {
    carrierVariants.push(operationRequestsSchema(capabilities, authority));
  }
  return { type: "object", anyOf: carrierVariants };
}

function phaseSubmissionSchema(submissionSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    properties: {
      kind: { const: "phase_submission" },
      submission: submissionSchema,
    },
    required: ["kind", "submission"],
    additionalProperties: false,
  };
}

function operationRequestsSchema(
  capabilities: readonly AvailablePhaseCapability[],
  authority: OperationAuthority,
): Record<string, unknown> {
  return {
    properties: {
      kind: { const: "operation_requests" },
      requests: {
        type: "array",
        minItems: 1,
        items: { anyOf: capabilities.map((capability) => operationSchema(capability, authority)) },
      },
    },
    required: ["kind", "requests"],
    additionalProperties: false,
  };
}

function operationSchema(
  capability: AvailablePhaseCapability,
  authority: OperationAuthority,
): Record<string, unknown> {
  const common = {
    capabilityRef: { const: capability.capabilityRef },
    input: {
      type: "string",
      description: "JSON text matching the cataloged inputSchema for this capability.",
    },
  };
  switch (capability.operationKind) {
    case "observe":
      return operationShape("observe", {
        ...common,
        scopeRef: { enum: capability.observationScopeRefs },
      });
    case "workspace_artifact_action":
      return operationShape("workspace_artifact_action", {
        ...common,
        workspaceRef: { const: requireMutation(authority, "workspace_only").workspaceRef },
        relativeTarget: { type: "string" },
      });
    case "review_validation":
      return operationShape("review_validation", {
        ...common,
        reviewSourceRef: {
          const: requireMutation(authority, "validation_overlay_only").reviewSourceRef,
        },
      });
    case "repository_promotion": {
      const mutation = requireMutation(authority, "repository_promotion_only");
      return operationShape("repository_promotion", {
        ...common,
        authorizationRef: { const: mutation.authorizationRef },
        candidateRef: { const: mutation.candidateRef },
        resolutionRef: { const: mutation.resolutionRef },
        baselineRef: { const: mutation.baselineRef },
        finalSnapshotRef: { const: mutation.finalSnapshotRef },
      });
    }
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
      kind: { const: kind },
      ...properties,
    },
    required: ["requestId", "kind", ...Object.keys(properties)],
    additionalProperties: false,
  };
}

function requireMutation<Kind extends OperationAuthority["mutation"]["kind"]>(
  authority: OperationAuthority,
  kind: Kind,
): Extract<OperationAuthority["mutation"], { kind: Kind }> {
  if (authority.mutation.kind !== kind) {
    throw new Error(`capability_authority_mismatch:${kind}`);
  }
  return authority.mutation as Extract<OperationAuthority["mutation"], { kind: Kind }>;
}
