import type { AdmittedModelSelection } from "../contracts.ts";
import type {
  ObservationResult,
  OperationRequest,
  PhaseRunBinding,
} from "../core/contracts.ts";

export type ResultRef = { id: string; sha256: string };

export type OperationSourceDescriptor =
  | {
      kind: "observe";
      capabilityRef: string;
      scopeRef: string;
      input: Record<string, unknown>;
    }
  | {
      kind: "workspace_artifact_observation";
      capabilityRef: string;
      workspaceRef: ResultRef;
      input: Record<string, unknown>;
    }
  | {
      kind: "review_validation";
      capabilityRef: string;
      reviewSourceRef: ResultRef;
      input: Record<string, unknown>;
    }
  | {
      kind: "workspace_artifact_action";
      capabilityRef: string;
      workspaceRef: ResultRef;
      relativeTarget: string;
    }
  | {
      kind: "repository_promotion";
      capabilityRef: string;
      authorizationRef: ResultRef;
      candidateRef: ResultRef;
      resolutionRef: ResultRef;
      baselineRef: ResultRef;
      finalSnapshotRef: ResultRef;
    };

export type OperationResultCompleteness =
  | "complete"
  | "requested_scope_complete"
  | "capture_incomplete";

export type CommandExecutionSummary = {
  kind: "command_execution";
  exitCode: number | null;
  timedOut: boolean;
  signal: string | null;
};

export type OperationResultRecord = {
  resultRef: ResultRef;
  requestRef: ResultRef;
  requestScope: string;
  requestId: string;
  capabilityRef: string;
  outcome: ObservationResult["outcome"];
  payloadRef: ResultRef;
  mediaType: "text/plain; charset=utf-8";
  byteLength: number;
  completeness: OperationResultCompleteness;
  observationRef: ResultRef;
  executionSummary?: CommandExecutionSummary;
  artifactRevisionRef?: ResultRef;
  targetSnapshotRef?: ResultRef;
  validationReceiptRef?: ResultRef;
  transactionRef?: ResultRef;
  commitJournalRef?: ResultRef;
  promotionReceiptRef?: ResultRef;
  promotedSnapshotRef?: ResultRef;
  promotionRecords?: NonNullable<ObservationResult["promotionRecords"]>;
};

export type OperationResultView = {
  selector: OperationResultSelector;
  content: string;
  byteStart: number;
  byteEnd: number;
  complete: boolean;
};

export type OperationResultProjection = {
  resultRef: ResultRef;
  requestRef: ResultRef;
  requestId: string;
  request: OperationRequest;
  capabilityRef: string;
  outcome: ObservationResult["outcome"];
  completeness: OperationResultCompleteness;
  byteLength: number;
  observationRef: ResultRef;
  executionSummary?: CommandExecutionSummary;
  preview: string;
  content?: string;
  omittedBytes: number;
  readScopeRef: string;
  view?: OperationResultView;
  artifactRevisionRef?: ResultRef;
  targetSnapshotRef?: ResultRef;
  validationReceiptRef?: ResultRef;
  transactionRef?: ResultRef;
  commitJournalRef?: ResultRef;
  promotionReceiptRef?: ResultRef;
  promotedSnapshotRef?: ResultRef;
  promotionRecords?: NonNullable<ObservationResult["promotionRecords"]>;
};

export type OperationResultIndexEntry = Pick<
  OperationResultProjection,
  | "resultRef"
  | "requestRef"
  | "requestId"
  | "capabilityRef"
  | "outcome"
  | "completeness"
  | "byteLength"
  | "observationRef"
  | "executionSummary"
  | "readScopeRef"
  | "artifactRevisionRef"
  | "targetSnapshotRef"
  | "validationReceiptRef"
  | "transactionRef"
  | "commitJournalRef"
  | "promotionReceiptRef"
  | "promotedSnapshotRef"
> & { source: OperationSourceDescriptor };

export type OperationResultSelector =
  | { kind: "bytes"; start: number; length: number }
  | { kind: "lines"; startLine: number; limit: number }
  | { kind: "search"; query: string; maxMatches: number }
  | { kind: "json_pointer"; pointer: string };

export interface OperationResultStore {
  find(input: {
    binding: PhaseRunBinding;
    request: OperationRequest;
    modelSelection: AdmittedModelSelection;
  }): Promise<OperationResultProjection | null>;
  record(input: {
    binding: PhaseRunBinding;
    request: OperationRequest;
    result: ObservationResult;
    modelSelection: AdmittedModelSelection;
  }): Promise<OperationResultProjection>;
  read(input: {
    request: Extract<OperationRequest, { kind: "observe" }>;
    modelSelection: AdmittedModelSelection;
  }): Promise<OperationResultProjection>;
}

export const READ_OPERATION_RESULT_CAPABILITY = "read_operation_result";

export function isResultReadRequest(
  request: OperationRequest,
): request is Extract<OperationRequest, { kind: "observe" }> {
  return request.kind === "observe" &&
    request.capabilityRef === READ_OPERATION_RESULT_CAPABILITY;
}
