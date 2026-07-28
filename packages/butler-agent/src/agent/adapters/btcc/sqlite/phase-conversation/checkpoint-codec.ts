import type {
  ActualModelIdentity,
  OperationRequest,
  PhaseContinuity,
  ProviderCorrection,
} from "../../../../btcc/gateway-api.ts";
import { digest, stableJson } from "../identity.ts";

export function decodePendingOperation(value: string): {
  kind: "operation_requests";
  requests: OperationRequest[];
  phaseContinuity?: PhaseContinuity;
  actualIdentity: ActualModelIdentity;
} {
  const parsed = JSON.parse(value) as {
    kind?: string;
    requests?: OperationRequest[];
    phaseContinuity?: PhaseContinuity;
    actualIdentity?: ActualModelIdentity;
  };
  if (
    parsed.kind !== "operation_requests" || !Array.isArray(parsed.requests) ||
    !parsed.actualIdentity
  ) {
    throw new Error("BTCC pending operation carrier is invalid");
  }
  return {
    kind: "operation_requests",
    requests: parsed.requests,
    ...(parsed.phaseContinuity ? { phaseContinuity: parsed.phaseContinuity } : {}),
    actualIdentity: parsed.actualIdentity,
  };
}

export function decodePendingSubmission(value: string): {
  kind: "phase_submission";
  submission: unknown;
  publicActivity?: PhaseContinuity["publicActivity"];
  actualIdentity: ActualModelIdentity;
} {
  const parsed = JSON.parse(value) as {
    kind?: string;
    submission?: unknown;
    publicActivity?: PhaseContinuity["publicActivity"];
    actualIdentity?: ActualModelIdentity;
  };
  if (parsed.kind !== "phase_submission" || !("submission" in parsed) || !parsed.actualIdentity) {
    throw new Error("BTCC pending phase submission carrier is invalid");
  }
  return {
    kind: "phase_submission",
    submission: parsed.submission,
    ...(parsed.publicActivity ? { publicActivity: parsed.publicActivity } : {}),
    actualIdentity: parsed.actualIdentity,
  };
}

export function decodeProviderCorrection(value: string): ProviderCorrection {
  const parsed = JSON.parse(value) as Partial<ProviderCorrection>;
  if (
    parsed.kind !== "previous_provider_product_rejected" ||
    (parsed.code !== "provider_protocol_interruption" &&
      parsed.code !== "provider_phase_submission_invalid")
  ) {
    throw new Error("BTCC provider correction is invalid");
  }
  return parsed as ProviderCorrection;
}

export function optionalJson(value: unknown): string | null {
  return value === undefined ? null : stableJson(value);
}

export function contentRefId(kind: string, json: string | null): string | null {
  return json === null ? null : digest(`btcc-${kind}.v1\0${json}`);
}

export function revisionRef(checkpointId: string, revision: number): string {
  return digest(`btcc-phase-checkpoint-revision.v1\0${checkpointId}\0${revision}`);
}
