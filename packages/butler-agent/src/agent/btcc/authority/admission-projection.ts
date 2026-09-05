import {
  AUTHORITY_DENIAL_TEXT,
  AUTHORITY_EFFECT_DENIAL_TEXT,
  type AuthorityAdmissionResult,
  type AuthorityRecord,
  type AuthorityRequestProjection,
} from "./contracts.ts";
import { permissionForRecord } from "./conversation-permission.ts";

export function admissionResult(record: AuthorityRecord): AuthorityAdmissionResult {
  if (record.decision === "allowed") {
    return {
      status: "allowed",
      requestRef: record.requestRef,
      sourceWorkId: record.sourceWorkId,
      normalizedTarget: record.normalizedTarget,
      normalizedInput: JSON.parse(record.normalizedInputJson),
    };
  }
  if (record.decision === "denied") {
    return {
      status: "denied",
      requestRef: record.requestRef,
      denialText: record.category === "reviewed_effect"
        ? AUTHORITY_EFFECT_DENIAL_TEXT
        : AUTHORITY_DENIAL_TEXT,
    };
  }
  if (record.decision === "modified") {
    return {
      status: "modified",
      requestRef: record.requestRef,
      replacementPending: true,
    };
  }
  return {
    status: "pending",
    requestRef: record.requestRef,
    projection: authorityProjection(record),
  };
}

export function authorityProjection(record: AuthorityRecord): AuthorityRequestProjection {
  const scope = permissionForRecord(record);
  return {
    request_ref: record.requestRef,
    category: record.category,
    reason: record.reason,
    executable: record.executable,
    command_count: 1,
    scope: { title: scope.title, description: scope.description },
    source_turn_id: record.sourceTurnId,
    source_session_id: record.sourceSessionId,
    ...(record.sourceCallId ? { source_call_id: record.sourceCallId } : {}),
  };
}
