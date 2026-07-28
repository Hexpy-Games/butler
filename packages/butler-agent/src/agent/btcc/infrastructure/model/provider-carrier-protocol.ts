import type {
  ActualModelIdentity,
  OperationAuthority,
  OperationRequest,
  PhaseContinuity,
  ProviderRoundValue,
} from "../../core/index.ts";
import { contentRef } from "../../core/index.ts";
import type {
  ProviderCarrierRejectionDiagnostic,
  ProviderCarrierRejectionReason,
  ProviderCarrierShape,
} from "../../recovery/index.ts";
import { validateJsonObjectSchema } from
  "../../../tools/tool-bridge/schema-validation.ts";

type CarrierAcceptance = {
  responseSchema: Record<string, unknown>;
  authority: OperationAuthority;
  actualIdentity: ActualModelIdentity;
};

export class ProviderCarrierProtocolError extends Error {
  override readonly name = "ProviderCarrierProtocolError";

  constructor(readonly diagnostic: ProviderCarrierRejectionDiagnostic) {
    super(`BTCC provider carrier rejected at ${diagnostic.path}: ${diagnostic.reason}`);
  }
}

export function acceptProviderCarrier(
  carrier: unknown,
  acceptance: CarrierAcceptance,
): ProviderRoundValue {
  const value = requireCarrierObject(carrier);
  assertRenderedSchema(value, acceptance.responseSchema);
  return decodeCarrier(value, acceptance.authority, acceptance.actualIdentity);
}

function requireCarrierObject(carrier: unknown): Record<string, unknown> {
  if (isRecord(carrier)) return carrier;
  rejectCarrier("carrier_not_object", "$", carrier);
}

function assertRenderedSchema(
  carrier: Record<string, unknown>,
  responseSchema: Record<string, unknown>,
): void {
  const validation = validateJsonObjectSchema(carrier, responseSchema);
  if (!validation.ok) {
    rejectCarrier(validation.reason, validation.path, carrier);
  }
}

function decodeCarrier(
  carrier: Record<string, unknown>,
  authority: OperationAuthority,
  actualIdentity: ActualModelIdentity,
): ProviderRoundValue {
  if (
    carrier.kind === "phase_submission" &&
    isRecord(carrier.submission) &&
    isRecord(carrier.publicActivity)
  ) {
    return {
      kind: "phase_submission",
      submission: carrier.submission,
      publicActivity: carrier.publicActivity as PhaseContinuity["publicActivity"],
      actualIdentity,
    };
  }
  if (
    carrier.kind === "operation_requests" &&
    isRecord(carrier.phaseContinuity) &&
    Array.isArray(carrier.requests) &&
    carrier.requests.length > 0 &&
    carrier.requests.every(isRecord)
  ) {
    return {
      kind: "operation_requests",
      requests: carrier.requests.map((request) => bindOperationAuthority(
        request,
        authority,
        carrier,
      )),
      phaseContinuity: carrier.phaseContinuity as PhaseContinuity,
      actualIdentity,
    };
  }
  rejectCarrier("closed_protocol_mismatch", "$.kind", carrier);
}

function bindOperationAuthority(
  value: Record<string, unknown>,
  authority: OperationAuthority,
  carrier: Record<string, unknown>,
): OperationRequest {
  if (value.kind === "observe") return value as OperationRequest;
  if (
    value.kind === "workspace_artifact_observation" &&
    authority.mutation.kind === "workspace_only"
  ) {
    return { ...value, workspaceRef: authority.mutation.workspaceRef } as OperationRequest;
  }
  if (value.kind === "workspace_artifact_action" && authority.mutation.kind === "workspace_only") {
    return { ...value, workspaceRef: authority.mutation.workspaceRef } as OperationRequest;
  }
  if (value.kind === "review_validation" &&
    authority.mutation.kind === "validation_overlay_only"
  ) {
    return { ...value, reviewSourceRef: authority.mutation.reviewSourceRef } as OperationRequest;
  }
  if (
    value.kind === "turn_local_effect" &&
    authority.mutation.kind === "turn_local_effect_only" &&
    typeof value.capabilityRef === "string" &&
    authority.mutation.capabilities.some(
      (capability) => capability.capabilityRef === value.capabilityRef,
    )
  ) {
    return value as OperationRequest;
  }
  if (value.kind === "external_effect" &&
    authority.mutation.kind === "external_effect_only"
  ) {
    return {
      ...value,
      effectIntentRef: authority.mutation.effectIntentRef,
      occurrenceKey: authority.mutation.occurrenceKey,
      targetScopeRef: authority.mutation.targetScopeRef,
    } as OperationRequest;
  }
  if (value.kind === "repository_promotion" &&
    authority.mutation.kind === "repository_promotion_only"
  ) {
    return {
      ...value,
      authorizationRef: authority.mutation.authorizationRef,
      candidateRef: authority.mutation.candidateRef,
      resolutionRef: authority.mutation.resolutionRef,
      baselineRef: authority.mutation.baselineRef,
      finalSnapshotRef: authority.mutation.finalSnapshotRef,
    } as OperationRequest;
  }
  return bindRejectedAuthority(value, carrier);
}

function bindRejectedAuthority(
  value: Record<string, unknown>,
  carrier: Record<string, unknown>,
): OperationRequest {
  const marker = {
    runtimeAdmission: {
      kind: "rejected" as const,
      code: "operation_authority_mismatch" as const,
    },
  };
  const rejectedRef = contentRef("rejected-operation-authority", {
    operationKind: value.kind,
    capabilityRef: value.capabilityRef,
  });
  if (value.kind === "workspace_artifact_action" ||
    value.kind === "workspace_artifact_observation"
  ) {
    return { ...value, ...marker, workspaceRef: rejectedRef } as OperationRequest;
  }
  if (value.kind === "review_validation") {
    return { ...value, ...marker, reviewSourceRef: rejectedRef } as OperationRequest;
  }
  if (value.kind === "turn_local_effect") {
    return { ...value, ...marker } as OperationRequest;
  }
  if (value.kind === "external_effect") {
    return {
      ...value,
      ...marker,
      effectIntentRef: rejectedRef,
      occurrenceKey: "rejected",
      targetScopeRef: "rejected:external-effect",
    } as OperationRequest;
  }
  if (value.kind === "repository_promotion") {
    return {
      ...value,
      ...marker,
      authorizationRef: rejectedRef,
      candidateRef: rejectedRef,
      resolutionRef: rejectedRef,
      baselineRef: rejectedRef,
      finalSnapshotRef: rejectedRef,
    } as OperationRequest;
  }
  rejectCarrier("closed_protocol_mismatch", "$.requests", carrier);
}

function rejectCarrier(
  reason: ProviderCarrierRejectionReason,
  path: string,
  carrier: unknown,
): never {
  throw new ProviderCarrierProtocolError({
    schema: "btcc.operational-diagnostic.v1",
    kind: "provider_carrier_rejection",
    path,
    reason,
    shape: describeProviderCarrierShape(carrier),
  });
}

export function describeProviderCarrierShape(carrier: unknown): ProviderCarrierShape {
  const value = isRecord(carrier) ? carrier : null;
  const submission = value && isRecord(value.submission) ? value.submission : null;
  const requests = value && Array.isArray(value.requests) ? value.requests : null;
  return {
    carrierType: jsonValueType(carrier),
    carrierKeys: safeKeys(value),
    ...(value && "submission" in value
      ? { submissionType: jsonValueType(value.submission) }
      : {}),
    submissionKeys: safeKeys(submission),
    ...(value && "requests" in value
      ? { requestsType: jsonValueType(value.requests) }
      : {}),
    ...(requests ? { requestCount: requests.length } : {}),
    requestKeys: requests?.slice(0, 16).map((request) =>
      safeKeys(isRecord(request) ? request : null),
    ) ?? [],
  };
}

function safeKeys(value: Record<string, unknown> | null): string[] {
  if (!value) return [];
  return Object.keys(value).filter(isSafeKey).sort().slice(0, 48);
}

function isSafeKey(value: string): boolean {
  if (!value || value.length > 64) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const safe = code >= 48 && code <= 57 || code >= 65 && code <= 90 ||
      code >= 97 && code <= 122 || character === "-" || character === "_" ||
      character === "." || character === ":" || character === "/";
    if (!safe) return false;
  }
  return true;
}

function jsonValueType(value: unknown): ProviderCarrierShape["carrierType"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as ProviderCarrierShape["carrierType"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
