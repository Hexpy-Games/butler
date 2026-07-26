import type {
  OperationExecutor,
  PhaseConversationStore,
  SelectedModel,
} from "./core/index.ts";
import type {
  CanonicalMessageStore,
  RetrospectiveScheduler,
} from "./delivery/index.ts";
import type {
  TurnAdmissionRepository,
  TurnStateRepository,
} from "./turn/index.ts";
import type { ArtifactWorkspaceRuntime } from "./artifact/index.ts";
import type { ContinuationCandidate } from "./continuation/index.ts";
import type { StopPersistenceOutcome } from "./turn/index.ts";
import type {
  CommittedSuccessorReadiness,
  OperationalActivation,
  OperationalRecoveryBoundary,
} from "./recovery/index.ts";
import type {
  AvailableSpecRevision,
  GoverningSpecRevision,
} from "./planning/contracts.ts";
import type { WorkProgressTask } from "./work-ledger/index.ts";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type AdmittedModelSelection = {
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  controls: Readonly<Record<string, string | number | boolean>>;
  controlsHash: string;
  contextWindowTokens?: number;
};

export type ButlerContextInput = {
  userRef: string;
  projectRef?: string;
  profileRefs: string[];
  recentFeedbackRefs: string[];
  mandatoryHotCacheRefs: string[];
  optionalHotCacheRefs: string[];
  baselineObservationScopeRefs: string[];
  continuationCandidates?: ContinuationCandidate[];
};

export type BtccTurnCommand =
  | {
      kind: "run";
      turnId: string;
      sessionId: string;
      triggerKey: string;
      message: { messageId: string; content: string };
      modelSelection: AdmittedModelSelection;
      context: ButlerContextInput;
    }
  | { kind: "resume"; turnId: string }
  | {
      kind: "wake";
      turnId: string;
      sessionId: string;
      triggerKey: string;
      trigger: {
        triggerId: string;
        sourceTurnId: string;
        authorizationRef: string;
        content: string;
      };
      modelSelection: AdmittedModelSelection;
      context: ButlerContextInput;
    }
  | { kind: "stop"; turnId: string };

export type FreshBtccTurnCommand = Extract<BtccTurnCommand, { kind: "run" | "wake" }>;

export type BtccTurnOutcome =
  | { kind: "delivered"; turnId: string; messageId: string; content: string }
  | { kind: "cancelled"; turnId: string }
  | { kind: "already_cancelled"; turnId: string }
  | { kind: "already_finalizing"; turnId: string }
  | { kind: "fenced_pending_persistence"; turnId: string }
  | Extract<StopPersistenceOutcome, { kind: "already_delivered" }>;

export interface BtccTurnRuntime {
  handle(command: BtccTurnCommand): Promise<BtccTurnOutcome>;
}

export interface BtccTurnProgressObserver {
  openingDecisionAccepted?(update: {
    turnId: string;
    turnRevision: number;
    decisionId: string;
    summary: string;
    rationale: string;
    nextStep: string;
  }): void | Promise<void>;
  stateChanged(update: {
    turnId: string;
    semanticState: string;
    turnRevision: number;
  }): void | Promise<void>;
  workProgressChanged?(update: {
    turnId: string;
    turnRevision: number;
    programId: string;
    tasks: WorkProgressTask[];
  }): void | Promise<void>;
  phaseActivityChanged?(update: {
    turnId: string;
    semanticState: string;
    summary: string;
    rationale: string;
    nextStep: string;
  }): void | Promise<void>;
  modelRoundWaiting?(update: {
    turnId: string;
    semanticState: string;
    checkpointId: string;
  }): void | Promise<void>;
  operationChanged?(update: {
    turnId: string;
    semanticState: string;
    requestId: string;
    publicTitle: string;
    capabilityRef: string;
    status: "started" | "completed" | "failed" | "cancelled";
    resultRef?: { id: string; sha256: string };
    byteLength?: number;
  }): void | Promise<void>;
  operationalNoticeChanged?(update: {
    turnId: string;
    semanticState: string;
    status: "recovering" | "cleared";
    code?: string;
    activationKind?: OperationalActivation["kind"];
  }): void | Promise<void>;
}

export interface GoverningSpecAuthority {
  listCatalog(projectRef: string): Promise<AvailableSpecRevision[]>;
  resolveSelected(
    projectRef: string,
    logicalIds: readonly string[],
  ): Promise<GoverningSpecRevision[]>;
}

export type BtccRuntimeDependencies = {
  admission: TurnAdmissionRepository;
  turns: TurnStateRepository;
  phaseConversations: PhaseConversationStore;
  model: SelectedModel;
  operations: OperationExecutor;
  artifacts: ArtifactWorkspaceRuntime;
  messages: CanonicalMessageStore;
  retrospective: RetrospectiveScheduler;
  operationalRecovery?: OperationalRecoveryBoundary;
  committedSuccessorReadiness?: CommittedSuccessorReadiness;
  governingSpecs?: GoverningSpecAuthority;
  progress?: BtccTurnProgressObserver;
};
