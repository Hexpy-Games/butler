import type { AdmittedModelSelection } from "../contracts.ts";

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
  userRef: string;
  projectRef?: string;
  profileRefs: string[];
  recentFeedbackRefs: string[];
  mandatoryHotCacheRefs: string[];
  optionalHotCacheRefs: string[];
  baselineObservationScopeRefs: string[];
  stateInput?: unknown;
};

export type PhaseEnvelope = {
  binding: PhaseRunBinding;
  phase: ModelPhaseState;
  objective: string;
  duties: readonly string[];
  prohibitions: readonly string[];
  exitDuties?: Readonly<Record<string, readonly string[]>>;
  authoringContractRefs?: readonly string[];
  authoringContracts?: readonly AuthoringContractBinding[];
  modelSelection: AdmittedModelSelection;
  context: OpeningContext;
  operationAuthority: OperationAuthority;
  operationResults: OperationResult[];
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
    };

export interface SelectedModel {
  runRound(envelope: PhaseEnvelope): Promise<ProviderRoundValue>;
}

export interface PhaseConversationStore {
  loadAcceptedProduct<Product>(binding: PhaseRunBinding): Promise<Product | null>;
  persistAcceptedProduct<Product>(input: {
    binding: PhaseRunBinding;
    product: Product;
    actualIdentity: ActualModelIdentity;
  }): Promise<void>;
  loadOperationResults(binding: PhaseRunBinding): Promise<OperationResult[]>;
  appendOperationResult(input: {
    binding: PhaseRunBinding;
    request: OperationRequest;
    result: OperationResult;
  }): Promise<void>;
}

export type OperationAuthority = {
  observationScopeRefs: string[];
  mutation: "forbidden";
};

export type OperationRequest = {
  requestId: string;
  kind: "observe";
  capabilityRef: string;
  scopeRef: string;
  input: string;
};

export type OperationResult = {
  requestId: string;
  request: OperationRequest;
  outcome: "observed";
  observationRef: { id: string; sha256: string };
  content: string;
};

export type ObservationResult = Omit<OperationResult, "request">;

export interface ObservationExecutor {
  perform(input: {
    request: OperationRequest;
    envelope: PhaseEnvelope;
  }): Promise<ObservationResult>;
}

export type PhaseCodec<Product> = {
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
  operations: ObservationExecutor;
  operationAuthority: OperationAuthority;
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
>;
