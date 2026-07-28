import type {
  CommandExecutionSummary,
  OperationResultCompleteness,
  OperationResultProjection,
} from "../operation-result/contracts.ts";
import type { PhaseEnvelope } from "./contracts.ts";

type Ref = { id: string; sha256: string };

export type TurnLocalEffectCapability = {
  capabilityRef: string;
  inputSchema: Record<string, unknown>;
};

export type WorkspaceOperationRoot =
  | { kind: "file"; relativeTarget: "target" }
  | { kind: "directory"; relativeTarget: "." };

export type WorkspaceMutationScope =
  | { kind: "read_only" }
  | { kind: "contained_paths"; writablePaths: string[] };

export type OperationAuthority = {
  observationScopeRefs: string[];
  mutation:
    | { kind: "forbidden" }
    | {
        kind: "workspace_only";
        workspaceRef: Ref;
        operationRoot: WorkspaceOperationRoot;
        mutationScope: WorkspaceMutationScope;
      }
    | { kind: "validation_overlay_only"; reviewSourceRef: Ref }
    | { kind: "turn_local_effect_only"; capabilities: TurnLocalEffectCapability[] }
    | {
        kind: "external_effect_only";
        effectIntentRef: Ref;
        occurrenceKey: string;
        targetScopeRef: string;
      }
    | {
        kind: "repository_promotion_only";
        authorizationRef: Ref;
        candidateRef: Ref;
        resolutionRef: Ref;
        baselineRef: Ref;
        finalSnapshotRef: Ref;
      };
};

export type OperationRequest = {
  requestId: string;
  publicTitle: string;
  runtimeAdmission?: { kind: "rejected"; code: "operation_authority_mismatch" };
} & (
  | { kind: "observe"; capabilityRef: string; scopeRef: string; input: Record<string, unknown> }
  | {
      kind: "workspace_artifact_action";
      capabilityRef: string;
      workspaceRef: Ref;
      relativeTarget: string;
      input: Record<string, unknown>;
    }
  | {
      kind: "workspace_artifact_observation";
      capabilityRef: string;
      workspaceRef: Ref;
      input: Record<string, unknown>;
    }
  | { kind: "review_validation"; capabilityRef: string; reviewSourceRef: Ref;
      input: Record<string, unknown> }
  | {
      kind: "turn_local_effect";
      capabilityRef: string;
      input: Record<string, unknown>;
    }
  | {
      kind: "external_effect";
      capabilityRef: string;
      effectIntentRef: Ref;
      occurrenceKey: string;
      targetScopeRef: string;
      input: Record<string, unknown>;
    }
  | {
      kind: "repository_promotion";
      capabilityRef: string;
      authorizationRef: Ref;
      candidateRef: Ref;
      resolutionRef: Ref;
      baselineRef: Ref;
      finalSnapshotRef: Ref;
      input: Record<string, unknown>;
    }
);

export type OperationResult = {
  requestId: string;
  request: OperationRequest;
  outcome:
    | "observed" | "operation_rejected" | "workspace_artifact_applied"
    | "external_effect_applied" | "review_validated" | "promoted"
    | "turn_local_effect_applied";
  observationRef: Ref;
  content?: string;
  completeness?: OperationResultCompleteness;
  resultRef?: OperationResultProjection["resultRef"];
  requestRef?: OperationResultProjection["requestRef"];
  capabilityRef?: string;
  byteLength?: number;
  preview?: string;
  omittedBytes?: number;
  readScopeRef?: string;
  view?: OperationResultProjection["view"];
  artifactRevisionRef?: Ref;
  targetSnapshotRef?: Ref;
  validationReceiptRef?: Ref;
  effectReceiptRef?: Ref;
  transactionRef?: Ref;
  commitJournalRef?: Ref;
  promotionReceiptRef?: Ref;
  promotedSnapshotRef?: Ref;
  promotionRecords?: {
    transaction: { ref: Ref; [key: string]: unknown };
    journals: Array<{ ref: Ref; state: string; [key: string]: unknown }>;
    commitReceipt: { ref: Ref; [key: string]: unknown };
    promotedSnapshot: { ref: Ref; [key: string]: unknown };
    cleanupReceipt: { ref: Ref; [key: string]: unknown };
  };
};

export type OperationPayloadSource = string | {
  kind: "spooled_text";
  path: string;
  sha256: string;
  byteLength: number;
  mediaType: "text/plain; charset=utf-8";
};

export type ObservationResult = Omit<OperationResult, "request" | "content"> & {
  content: string;
  payloadSource?: OperationPayloadSource;
  executionSummary?: CommandExecutionSummary;
};

export interface OperationExecutor {
  perform(input: {
    request: OperationRequest;
    envelope: PhaseEnvelope;
    signal?: AbortSignal;
  }): Promise<ObservationResult | OperationResultProjection>;
}
