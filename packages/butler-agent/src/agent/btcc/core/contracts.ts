import type { AdmittedModelSelection } from "../contracts.ts";
import type { ContinuationCandidate } from "../continuation/index.ts";
import type { ExecutionPermit } from "../recovery/index.ts";
import type { OperationalActivation } from "../recovery/index.ts";
import type { OperationalDiagnostic } from "../recovery/index.ts";
import type { SubmissionSchema } from "./submission-schema.ts";
import type { PromptDutyId, PromptProhibitionId } from "./prompt-contract.ts";
import type { OperationResultProjection } from "../operation-result/contracts.ts";
import type {
  OperationAuthority,
  OperationExecutor,
  OperationRequest,
  OperationResult,
} from "./operation-contracts.ts";
export type {
  ObservationResult,
  OperationAuthority,
  OperationExecutor,
  OperationPayloadSource,
  OperationRequest,
  OperationResult,
  WorkspaceMutationScope,
  WorkspaceOperationRoot,
} from "./operation-contracts.ts";
import type {
  PhaseActivityPublisher,
  PublicPhaseActivity,
} from "./phase-activity.ts";

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
  | "assisted_answer"
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
  continuationCandidates?: ContinuationCandidate[];
  stateInput?: unknown;
};

export type PhaseEnvelope = {
  binding: PhaseRunBinding;
  phase: ModelPhaseState;
  operationSurface: "closed" | "authorized";
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
  latestOperationResultCount?: number;
  phaseContinuity?: PhaseContinuity;
  submissionSchema: SubmissionSchema;
  providerCorrection?: ProviderCorrection;
};

export type ProviderCorrection = {
  kind: "previous_provider_product_rejected";
  code: "provider_protocol_interruption" | "provider_phase_submission_invalid";
  diagnostic?: OperationalDiagnostic;
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
  | "operationSurface"
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
      publicActivity?: PublicPhaseActivity;
      actualIdentity: ActualModelIdentity;
    }
  | {
      kind: "operation_requests";
      requests: OperationRequest[];
      phaseContinuity?: PhaseContinuity;
      actualIdentity: ActualModelIdentity;
    }
  | {
      kind: "interruption";
      code: string;
      activation: OperationalActivation;
      diagnosticMessage?: string;
      diagnostic?: OperationalDiagnostic;
    };

export interface SelectedModel {
  runRound(envelope: PhaseEnvelope, signal?: AbortSignal): Promise<ProviderRoundValue>;
}

export type PhaseConversationSnapshot<Product> = {
  binding: PhaseRunBinding;
  acceptedProduct: Product | null;
  acceptedActualIdentity?: ActualModelIdentity;
  providerCorrection?: ProviderCorrection;
  operationResults: OperationResult[];
  latestOperationResultCount?: number;
  phaseContinuity?: PhaseContinuity;
  pendingOperationRound?: {
    requests: OperationRequest[];
    phaseContinuity?: PhaseContinuity;
    actualIdentity: ActualModelIdentity;
  };
  pendingSubmissionRound?: {
    submission: unknown;
    publicActivity?: PublicPhaseActivity;
    actualIdentity: ActualModelIdentity;
  };
};

export interface PhaseConversationStore {
  restore<Product>(binding: PhaseRunBinding): Promise<PhaseConversationSnapshot<Product>>;
  appendOperationRound(input: {
    binding: PhaseRunBinding;
    envelope: PhaseEnvelope;
    requests: OperationRequest[];
    phaseContinuity?: PhaseContinuity;
    actualIdentity: ActualModelIdentity;
  }): Promise<PhaseRunBinding>;
  appendOperationResults(input: {
    binding: PhaseRunBinding;
    results: Array<{ request: OperationRequest; result: OperationResult }>;
  }): Promise<PhaseRunBinding>;
  appendProviderProductRejection(input: {
    binding: PhaseRunBinding;
    envelope: PhaseEnvelope;
    submission: unknown;
    publicActivity?: PublicPhaseActivity;
    actualIdentity: ActualModelIdentity;
    correction: ProviderCorrection;
  }): Promise<PhaseRunBinding>;
  appendPhaseSubmission(input: {
    binding: PhaseRunBinding;
    envelope: PhaseEnvelope;
    submission: unknown;
    publicActivity?: PublicPhaseActivity;
    actualIdentity: ActualModelIdentity;
  }): Promise<PhaseRunBinding>;
  acceptPhaseProduct<Product>(input: {
    binding: PhaseRunBinding;
    product: Product;
  }): Promise<PhaseRunBinding>;
}

export type PhaseContinuity = {
  objectiveState: string;
  decisions: string[];
  unresolved: string[];
  nextOperationPurpose: string;
  publicActivity: PublicPhaseActivity;
};

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
  activity?: PhaseActivityPublisher;
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
  | "activity"
  | "providerCorrection"
>;
