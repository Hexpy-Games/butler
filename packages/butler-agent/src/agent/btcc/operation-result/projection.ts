import { createHash } from "node:crypto";
import type { AdmittedModelSelection } from "../contracts.ts";
import type {
  ObservationResult,
  OperationRequest,
  PhaseRunBinding,
} from "../core/contracts.ts";
import type {
  OperationResultProjection,
  OperationResultRecord,
  ResultRef,
} from "./contracts.ts";

export function projectEphemeralOperationResult(input: {
  binding: PhaseRunBinding;
  request: OperationRequest;
  result: ObservationResult;
  modelSelection: AdmittedModelSelection;
}): OperationResultProjection {
  const bytes = Buffer.from(input.result.content, "utf8");
  const payloadRef = ref("operation-payload", bytes);
  const requestRef = ref("operation-request", stableJson(input.request));
  const resultRef = ref("operation-result", stableJson({
    requestScope: requestScope(input.binding),
    requestRef,
    payloadRef,
    outcome: input.result.outcome,
    observationRef: input.result.observationRef,
  }));
  const record: OperationResultRecord = {
    resultRef,
    requestRef,
    requestScope: requestScope(input.binding),
    requestId: input.request.requestId,
    capabilityRef: input.request.capabilityRef,
    outcome: input.result.outcome,
    payloadRef,
    mediaType: "text/plain; charset=utf-8",
    byteLength: bytes.byteLength,
    completeness: "complete",
    observationRef: input.result.observationRef,
    ...(input.result.executionSummary
      ? { executionSummary: input.result.executionSummary }
      : {}),
    ...structuralRefs(input.result),
  };
  return projectRecord({
    record,
    request: input.request,
    payload: bytes,
    maxPreviewBytes: projectionBudgetBytes(input.modelSelection),
  });
}

export function projectRecord(input: {
  record: OperationResultRecord;
  request: OperationRequest;
  payload: Buffer;
  maxPreviewBytes: number;
}): OperationResultProjection {
  const previewBytes = Math.min(input.payload.byteLength, input.maxPreviewBytes);
  const preview = input.payload.subarray(0, previewBytes).toString("utf8");
  const projectedBytes = Buffer.byteLength(preview, "utf8");
  return {
    resultRef: input.record.resultRef,
    requestRef: input.record.requestRef,
    requestId: input.request.requestId,
    request: input.request,
    capabilityRef: input.record.capabilityRef,
    outcome: input.record.outcome,
    completeness: input.record.completeness,
    byteLength: input.record.byteLength,
    observationRef: input.record.observationRef,
    ...(input.record.executionSummary
      ? { executionSummary: input.record.executionSummary }
      : {}),
    preview,
    omittedBytes: Math.max(0, input.record.byteLength - projectedBytes),
    readScopeRef: resultScopeRef(input.record.resultRef),
    ...structuralRefs(input.record),
  };
}

export function projectionBudgetBytes(selection: AdmittedModelSelection): number {
  const contextTokens = selection.contextWindowTokens;
  if (contextTokens && Number.isFinite(contextTokens) && contextTokens > 0) {
    return Math.max(2_048, Math.floor(contextTokens * 4 * 0.01));
  }
  return 32_768;
}

export function resultScopeRef(resultRef: ResultRef): string {
  return `result:${encodeURIComponent(resultRef.id)}:${resultRef.sha256}`;
}

export function parseResultScopeRef(scopeRef: string): ResultRef {
  const [kind, id, sha256, ...rest] = scopeRef.split(":");
  if (kind !== "result" || !id || !sha256 || rest.length > 0) {
    throw new Error("Operation result read scope is invalid");
  }
  return { id: decodeURIComponent(id), sha256 };
}

export function requestScope(binding: PhaseRunBinding): string {
  return [
    binding.turnId,
    binding.turnRevision,
    binding.semanticState,
    binding.checkpointId,
    binding.checkpointRevision,
  ].join(":");
}

export function ref(kind: string, value: string | Buffer): ResultRef {
  const sha256 = createHash("sha256").update(value).digest("hex");
  return { id: `${kind}:${sha256}`, sha256 };
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sort(value));
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sort(item)]),
  );
}

function structuralRefs(
  result: ObservationResult | OperationResultRecord,
) {
  return {
    ...("artifactRevisionRef" in result && result.artifactRevisionRef
      ? { artifactRevisionRef: result.artifactRevisionRef }
      : {}),
    ...("targetSnapshotRef" in result && result.targetSnapshotRef
      ? { targetSnapshotRef: result.targetSnapshotRef }
      : {}),
    ...("validationReceiptRef" in result && result.validationReceiptRef
      ? { validationReceiptRef: result.validationReceiptRef }
      : {}),
    ...("effectReceiptRef" in result && result.effectReceiptRef
      ? { effectReceiptRef: result.effectReceiptRef }
      : {}),
    ...("transactionRef" in result && result.transactionRef
      ? { transactionRef: result.transactionRef }
      : {}),
    ...("commitJournalRef" in result && result.commitJournalRef
      ? { commitJournalRef: result.commitJournalRef }
      : {}),
    ...("promotionReceiptRef" in result && result.promotionReceiptRef
      ? { promotionReceiptRef: result.promotionReceiptRef }
      : {}),
    ...("promotedSnapshotRef" in result && result.promotedSnapshotRef
      ? { promotedSnapshotRef: result.promotedSnapshotRef }
      : {}),
    ...("promotionRecords" in result && result.promotionRecords
      ? { promotionRecords: result.promotionRecords }
      : {}),
  };
}
