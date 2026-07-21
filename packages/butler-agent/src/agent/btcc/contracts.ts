import type {
  OperationExecutor,
  PhaseConversationStore,
  SelectedModel,
} from "./core/index.ts";
import type {
  CanonicalMessageStore,
  LearningSourceScheduler,
} from "./delivery/index.ts";
import type {
  TurnAdmissionRepository,
  TurnStateRepository,
} from "./turn/index.ts";
import type { ArtifactWorkspaceRuntime } from "./artifact/index.ts";
import type { DeferredContinuationCandidate } from "./continuation/index.ts";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type AdmittedModelSelection = {
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  controls: Readonly<Record<string, string | number | boolean>>;
  controlsHash: string;
};

export type ButlerContextInput = {
  userRef: string;
  projectRef?: string;
  profileRefs: string[];
  recentFeedbackRefs: string[];
  mandatoryHotCacheRefs: string[];
  optionalHotCacheRefs: string[];
  baselineObservationScopeRefs: string[];
  continuationCandidates?: DeferredContinuationCandidate[];
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
  | { kind: "wake"; turnId: string; triggerId: string }
  | { kind: "stop"; turnId: string };

export type BtccTurnOutcome =
  | { kind: "delivered"; turnId: string; messageId: string; content: string }
  | { kind: "cancelled"; turnId: string };

export interface BtccTurnRuntime {
  handle(command: BtccTurnCommand): Promise<BtccTurnOutcome>;
}

export type BtccRuntimeDependencies = {
  admission: TurnAdmissionRepository;
  turns: TurnStateRepository;
  phaseConversations: PhaseConversationStore;
  model: SelectedModel;
  operations: OperationExecutor;
  artifacts: ArtifactWorkspaceRuntime;
  messages: CanonicalMessageStore;
  learning: LearningSourceScheduler;
};
