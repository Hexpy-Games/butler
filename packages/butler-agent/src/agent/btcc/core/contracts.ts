import type { AdmittedModelSelection } from "../contracts.ts";
import type { DeferredContinuationCandidate } from "../continuation/index.ts";
import type { ExecutionPermit } from "../recovery/index.ts";
import type { OperationalActivation } from "../recovery/index.ts";
import type { SubmissionSchema } from "./submission-schema.ts";
import type { PromptDutyId, PromptProhibitionId } from "./prompt-contract.ts";
import type { OperationResultProjection } from "../operation-result/contracts.ts";
import type { OperationResultCompleteness } from "../operation-result/contracts.ts";

export type PhaseRunBinding = {
  turnId: string;
  turnRevision: number;
  semanticState: ModelPhaseState;
  checkpointId: string;
  checkpointRevision: number;
  claimId: string;
  executionFence: number;
};

export type ModelPhaseState =
  | "conception_opening"
  | "conception_deliberation"
  | "contract_review"
  | "planning"
  | "planning_review"
  | "task_execution"
  | "task_review"
  | "feedback_conception"
  | "feedback_planning"
  | "feedback_planning_review"
  | "consolidation"
  | "reporting";

export type OpeningContext = {
  originalMessageId: string;
  originalMessage: string;
  sessionId: string;
  userRef: string;
  projectRef?: string;
  profileRefs: string[];
  recentFeedbackRefs: string[];
  mandatoryHotCacheRefs: string[];
  optionalHotCacheRefs: string[];
  baselineObservationScopeRefs: string[];
  continuationCandidates?: DeferredContinuationCandidate[];
  stateInput?: unknown;
};

export type PhaseEnvelope = {
  binding: PhaseRunBinding;
  phase: ModelPhaseState;
  objective: string;
  duties: readonly PromptDutyId[];
  prohibitions: readonly PromptProhibitionId[];
  exitDuties?: Readonly<Record<string, readonly PromptDutyId[]>>;
  authoringContractRefs?: readonly string[];
  authoringContracts?: readonly AuthoringContractBinding[];
  modelSelection: AdmittedModelSelection;
  context: OpeningContext;
  operationAuthority: OperationAuthority;
  operationResults: OperationResultProjection[];
  submissionSchema: SubmissionSchema;
  providerCorrection?: ProviderCorrection;
};

export type ProviderCorrection = {
  kind: "previous_provider_product_rejected";
  code: "provider_protocol_interruption" | "provider_phase_submission_invalid";
  diagnosticMessage?: string;
};

export type AuthoringContractBinding = {
  contractId: string;
  revisionRef: { id: string; sha256: string };
  applicableRules: readonly string[];
};

export type PhaseContract = Pick<
  PhaseEnvelope,
  | "phase"
  | "objective"
  | "duties"
  | "prohibitions"
  | "exitDuties"
  | "authoringContractRefs"
  | "authoringContracts"
>;

export type ActualModelIdentity = {
  provider: string;
  model: string;
  reasoningEffort: string;
  controlsHash: string;
};

export type ProviderRoundValue =
  | {
      kind: "phase_submission";
      submission: unknown;
      actualIdentity: ActualModelIdentity;
    }
  | {
      kind: "operation_requests";
      requests: OperationRequest[];
      actualIdentity: ActualModelIdentity;
    }
  | {
      kind: "interruption";
      code: string;
      activation: OperationalActivation;
      diagnosticMessage?: string;
    };

export interface SelectedModel {
  runRound(envelope: PhaseEnvelope, signal?: AbortSignal): Promise<ProviderRoundValue>;
}

export type PhaseConversationSnapshot<Product> = {
  binding: PhaseRunBinding;
  acceptedProduct: Product | null;
  acceptedActualIdentity?: ActualModelIdentity;
  operationResults: OperationResult[];
  pendingOperationRound?: {
    requests: OperationRequest[];
    actualIdentity: ActualModelIdentity;
  };
  pendingSubmissionRound?: {
    submission: unknown;
    actualIdentity: ActualModelIdentity;
  };
};

export interface PhaseConversationStore {
  restore<Product>(binding: PhaseRunBinding): Promise<PhaseConversationSnapshot<Product>>;
  appendOperationRound(input: {
    binding: PhaseRunBinding;
    envelope: PhaseEnvelope;
    requests: OperationRequest[];
    actualIdentity: ActualModelIdentity;
  }): Promise<PhaseRunBinding>;
  appendOperationResults(input: {
    binding: PhaseRunBinding;
    results: Array<{ request: OperationRequest; result: OperationResult }>;
  }): Promise<PhaseRunBinding>;
  appendPhaseSubmission(input: {
    binding: PhaseRunBinding;
    envelope: PhaseEnvelope;
    submission: unknown;
    actualIdentity: ActualModelIdentity;
  }): Promise<PhaseRunBinding>;
  acceptPhaseProduct<Product>(input: {
    binding: PhaseRunBinding;
    product: Product;
  }): Promise<PhaseRunBinding>;
}

export type OperationAuthority = {
  observationScopeRefs: string[];
  mutation:
    | { kind: "forbidden" }
    | {
        kind: "workspace_only";
        workspaceRef: { id: string; sha256: string };
        operationRoot: WorkspaceOperationRoot;
        mutationScope: WorkspaceMutationScope;
      }
    | { kind: "validation_overlay_only"; reviewSourceRef: { id: string; sha256: string } }
    | {
        kind: "repository_promotion_only";
        authorizationRef: { id: string; sha256: string };
        candidateRef: { id: string; sha256: string };
        resolutionRef: { id: string; sha256: string };
        baselineRef: { id: string; sha256: string };
        finalSnapshotRef: { id: string; sha256: string };
      };
};

export type WorkspaceOperationRoot =
  | { kind: "file"; relativeTarget: "target" }
  | { kind: "directory"; relativeTarget: "." };

export type WorkspaceMutationScope =
  | { kind: "read_only" }
  | { kind: "contained_paths"; writablePaths: string[] };

export type OperationRequest =
  | {
      requestId: string;
      kind: "observe";
      capabilityRef: string;
      scopeRef: string;
      input: Record<string, unknown>;
    }
  | {
      requestId: string;
      kind: "workspace_artifact_action";
      capabilityRef: string;
      workspaceRef: { id: string; sha256: string };
      relativeTarget: string;
      input: Record<string, unknown>;
    }
  | {
      requestId: string;
      kind: "workspace_artifact_observation";
      capabilityRef: string;
      workspaceRef: { id: string; sha256: string };
      input: Record<string, unknown>;
    }
  | {
      requestId: string;
      kind: "review_validation";
      capabilityRef: string;
      reviewSourceRef: { id: string; sha256: string };
      input: Record<string, unknown>;
    }
  | {
      requestId: string;
      kind: "repository_promotion";
      capabilityRef: string;
      authorizationRef: { id: string; sha256: string };
      candidateRef: { id: string; sha256: string };
      resolutionRef: { id: string; sha256: string };
      baselineRef: { id: string; sha256: string };
      finalSnapshotRef: { id: string; sha256: string };
      input: Record<string, unknown>;
    };

export type OperationResult = {
  requestId: string;
  request: OperationRequest;
  outcome:
    | "observed"
    | "operation_rejected"
    | "workspace_artifact_applied"
    | "review_validated"
    | "promoted";
  observationRef: { id: string; sha256: string };
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
  artifactRevisionRef?: { id: string; sha256: string };
  targetSnapshotRef?: { id: string; sha256: string };
  validationReceiptRef?: { id: string; sha256: string };
  transactionRef?: { id: string; sha256: string };
  commitJournalRef?: { id: string; sha256: string };
  promotionReceiptRef?: { id: string; sha256: string };
  promotedSnapshotRef?: { id: string; sha256: string };
  promotionRecords?: {
    transaction: { ref: { id: string; sha256: string }; [key: string]: unknown };
    journals: Array<{ ref: { id: string; sha256: string }; state: string; [key: string]: unknown }>;
    commitReceipt: { ref: { id: string; sha256: string }; [key: string]: unknown };
    promotedSnapshot: { ref: { id: string; sha256: string }; [key: string]: unknown };
    cleanupReceipt: { ref: { id: string; sha256: string }; [key: string]: unknown };
  };
};

export type OperationPayloadSource =
  | string
  | {
      kind: "spooled_text";
      path: string;
      sha256: string;
      byteLength: number;
      mediaType: "text/plain; charset=utf-8";
    };

export type ObservationResult =
  Omit<OperationResult, "request" | "content">
  & {
      content: string;
      payloadSource?: OperationPayloadSource;
    };

export interface OperationExecutor {
  perform(input: {
    request: OperationRequest;
    envelope: PhaseEnvelope;
    signal?: AbortSignal;
  }): Promise<ObservationResult | OperationResultProjection>;
}

export type PhaseCodec<Product> = {
  submissionSchema: SubmissionSchema;
  decode(submission: unknown, envelope: PhaseEnvelope): Product;
};

export type PhaseConversationCommand<Product> = {
  binding: PhaseRunBinding;
  modelSelection: AdmittedModelSelection;
  context: OpeningContext;
  phaseContract: PhaseContract;
  codec: PhaseCodec<Product>;
  store: PhaseConversationStore;
  model: SelectedModel;
  operations: OperationExecutor;
  operationAuthority: OperationAuthority;
  executionPermit: ExecutionPermit;
  providerCorrection?: ProviderCorrection;
};

export type PhaseInvocation = Pick<
  PhaseConversationCommand<unknown>,
  | "binding"
  | "modelSelection"
  | "context"
  | "store"
  | "model"
  | "operations"
  | "operationAuthority"
  | "executionPermit"
  | "providerCorrection"
>;
