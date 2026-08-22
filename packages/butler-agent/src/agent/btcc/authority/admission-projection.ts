import {
  AUTHORITY_DENIAL_TEXT,
  type AuthorityAdmissionResult,
  type AuthorityRecord,
  type AuthorityRequestProjection,
} from "./contracts.ts";

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
      denialText: AUTHORITY_DENIAL_TEXT,
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
  return {
    request_ref: record.requestRef,
    category: record.category,
    reason: record.reason,
    executable: record.executable,
    command_count: 1,
  };
}
