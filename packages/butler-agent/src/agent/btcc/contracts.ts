import type { StopPersistenceOutcome } from "./turn/contracts.ts";

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
  executionPolicy?: ButlerExecutionPolicy;
  attachments?: ButlerAttachmentRef[];
};

export type ButlerExecutionPolicy = {
  role: string;
  accessMode: "full_access" | "ask_first" | "read_only";
  trackingMode: "ledger" | "local" | "none";
  requiredNativeToolProfiles: string[];
  requiredNativeTools: string[];
  workspacePath: string;
  projectId?: string;
};

export type ButlerAttachmentRef = {
  id: string;
  kind: "image" | "audio" | "video" | "document" | "binary";
  mimeType?: string;
  fileName?: string;
  sizeBytes?: number;
  url?: string;
  localPath?: string;
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
export type BtccRunCommand = Exclude<BtccTurnCommand, { kind: "stop" }>;
export type BtccStopCommand = Extract<BtccTurnCommand, { kind: "stop" }>;

export type BtccTurnOutcome =
  | { kind: "delivered"; turnId: string; messageId: string; content: string }
  | { kind: "cancelled"; turnId: string }
  | { kind: "already_cancelled"; turnId: string }
  | { kind: "already_finalizing"; turnId: string }
  | { kind: "fenced_pending_persistence"; turnId: string }
  | Extract<StopPersistenceOutcome, { kind: "already_delivered" }>;

export interface BtccTurnRuntime {
  runTurn(command: BtccRunCommand): Promise<BtccTurnOutcome>;
  stopTurn(command: BtccStopCommand): Promise<BtccTurnOutcome>;
}

export type WorkProgressTask = {
  taskId: string;
  taskTitle: string;
  taskOutcome: string;
  taskOrder: number;
  taskState: "planned" | "active" | "reviewing" | "completed" |
    "correction_required" | "stopped" | "blocked" | "skipped";
  workId: string;
  workTitle: string;
  workState: "planned" | "active" | "completed" | "cancelled";
};

export interface BtccTurnProgressObserver {
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
    activityId: string;
    displayStage?: "conception" | "planning" | "execution" | "review" |
      "validation" | "reporting";
    title: string;
    summary: string;
    rationale?: string;
    nextStep?: string;
  }): void | Promise<void>;
  operationChanged?(update: {
    turnId: string;
    semanticState: string;
    activityId: string;
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
    status: "recovering" | "interrupted" | "cleared";
    code?: string;
    activationKind?: "automatic_storage_recovery" | "cancelled";
  }): void | Promise<void>;
}
