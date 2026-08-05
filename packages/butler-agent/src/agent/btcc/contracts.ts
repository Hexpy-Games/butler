import type { StopPersistenceOutcome } from "./turn/index.ts";
import type { RuntimeTurnEventInput } from "../events/turn-events.ts";
import type { ToolProgressSummary } from "../tools/tool-support.ts";
import type { ModelRouteState } from "./model-route/index.ts";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type AdmittedModelSelection = {
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  controls: Readonly<Record<string, string | number | boolean>>;
  controlsHash: string;
  contextWindowTokens?: number;
  modelRoute?: ModelRouteState;
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

export type BtccTurnExecutionControls = {
  schema_version: string;
  turn_id: string;
  session_id: string;
  model_ref: `${string}/${string}`;
  reasoning_effort: ReasoningEffort;
  access_mode: "full_access" | "ask_first" | "read_only";
  plan_mode: boolean;
  source: string;
  session_control_revision: number;
  catalog_generation: string;
  resolved_at: string;
  integrity_hash: string;
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
      progressDestination?: BtccProgressDestination;
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
        resultScopeRef?: string;
        content: string;
      };
      modelSelection: AdmittedModelSelection;
      context: ButlerContextInput;
      progressDestination?: BtccProgressDestination;
    }
  | { kind: "stop"; turnId: string };

export type FreshBtccTurnCommand = Extract<BtccTurnCommand, { kind: "run" | "wake" }>;
export type BtccRunCommand = Exclude<BtccTurnCommand, { kind: "stop" }>;
export type BtccStopCommand = Extract<BtccTurnCommand, { kind: "stop" }>;

export type BtccTurnOutcome = (
  | { kind: "delivered"; turnId: string; messageId: string; content: string }
  | { kind: "cancelled"; turnId: string }
  | { kind: "already_cancelled"; turnId: string }
  | { kind: "already_finalizing"; turnId: string }
  | { kind: "fenced_pending_persistence"; turnId: string }
  | Extract<StopPersistenceOutcome, { kind: "already_delivered" }>
) & {
  /** Non-semantic admission telemetry for transport-side optional UI work. */
  admission?: "fresh" | "replay";
};

export type BtccProgressDestination = {
  transport: string;
  accountId: string;
  peer: {
    kind: "dm" | "group" | "thread" | "channel";
    id: string;
    parentId?: string;
  };
  replyToMessageId: string;
};

export type BtccCommittedProgressEvent = {
  eventId: string;
  actionId: string;
  sessionId: string;
  turnId: string;
  sessionSequence: number;
  turnSequence: number;
  event: RuntimeTurnEventInput;
  destination: BtccProgressDestination;
  status: "pending" | "published";
};

export interface BtccProgressEventRepository {
  append(input: {
    sessionId: string;
    turnId: string;
    destination: BtccProgressDestination;
    event: RuntimeTurnEventInput;
  }): BtccCommittedProgressEvent;
  pending(turnId?: string): BtccCommittedProgressEvent[];
  forTurn(turnId: string): BtccCommittedProgressEvent[];
  markPublished(eventId: string): void;
}

export interface BtccTurnProgressPublisher {
  publish(event: BtccCommittedProgressEvent): Promise<void> | void;
}

/**
 * Transport-neutral facts admitted by the BTCC public facade.
 *
 * A replay is represented by the same logical request.  The durable Turn
 * decides whether that request is fresh, a continuation, or already terminal;
 * callers never send a transport-specific lifecycle marker.
 */
export type BtccTurnRequest = {
  turnId: string;
  sessionId: string;
  eventId: string;
  transport: string;
  accountId: string;
  peer: {
    kind: "dm" | "group" | "thread" | "channel";
    id: string;
    parentId?: string;
  };
  sender: {
    id: string;
    displayName?: string;
  };
  message: {
    id: string;
    content: string;
    timestamp: string;
    attachments?: ButlerAttachmentRef[];
  };
  trigger:
    | {
        kind: "user_message";
      }
    | {
        kind: "authorized_wake";
        triggerId: string;
        sourceTurnId: string;
        authorizationRef: string;
        resultScopeRef?: string;
      };
  route: {
    role: "butler" | "steward";
    workspacePath: string;
    projectId?: string;
    reason?:
      | "session-hint"
      | "steward-hint"
      | "project-hint"
      | "transport-binding"
      | "app-worker-result"
      | "app-planned-worker-review"
      | "butler-fallback";
  };
  progressDestination?: BtccProgressDestination;
  executionControls?: BtccTurnExecutionControls;
  signal?: AbortSignal;
};

export type BtccStopRequest = { turnId: string };

export interface BtccPreparedTurn {
  readonly command: BtccRunCommand;
  readonly isFresh: boolean;
  recordEvent(event: RuntimeTurnEventInput): void;
  complete(outcome: Extract<BtccTurnOutcome, { kind: "delivered" | "already_delivered" }>):
    Promise<void> | void;
  cancel(outcome: Extract<BtccTurnOutcome, {
    kind: "cancelled" | "already_cancelled" | "fenced_pending_persistence" | "already_finalizing";
  }>): Promise<void> | void;
}

export interface BtccTurnPreparation {
  prepare(request: BtccTurnRequest): Promise<BtccPreparedTurn>;
}

export interface Btcc {
  runTurn(request: BtccTurnRequest): Promise<BtccTurnOutcome>;
  stopTurn(request: BtccStopRequest): Promise<BtccTurnOutcome>;
}

export type BtccWakeCompletionCandidate = {
  taskId: string;
  originSessionId: string;
  sourceTurnId: string;
  authorizationRef: string;
  resultScopeRef?: string;
  resultText: string;
};

export type BtccWakeProjectionSummary = {
  candidates: number;
  authorized: number;
  rejected: number;
  dispatched: number;
  pending: number;
};

export interface BtccWakeProjectionHost {
  reconcile(
    candidates: readonly BtccWakeCompletionCandidate[],
  ): Promise<BtccWakeProjectionSummary>;
}

export interface BtccProgressProjectionHost {
  hasCommittedEvent(turnId: string, kind: string): boolean;
  reconcile(publisher: BtccTurnProgressPublisher): Promise<{
    attempted: number;
    published: number;
    pending: number;
  }>;
}

export interface BtccHost {
  progress: BtccProgressProjectionHost;
  wake?: BtccWakeProjectionHost;
  close(): Promise<void> | void;
}

export interface BtccTurnRuntime {
  runTurn(
    command: BtccRunCommand,
    progress?: BtccTurnProgressObserver,
    onAdmitted?: (isFresh: boolean) => void | Promise<void>,
  ): Promise<BtccTurnOutcome>;
  stopTurn(command: BtccStopCommand): Promise<BtccTurnOutcome>;
}

export type WorkProgressTask = {
  taskId: string;
  taskTitle: string;
  taskDescription: string;
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
    modelRef?: string;
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
    modelRef?: string;
  }): void | Promise<void>;
  operationChanged?(update: {
    turnId: string;
    semanticState: string;
    activityId: string;
    requestId: string;
    publicTitle: string;
    capabilityRef: string;
    status: "started" | "completed" | "failed" | "cancelled";
    inputLabel?: ToolProgressSummary["inputLabel"];
    detailRows?: ToolProgressSummary["detailRows"];
    resultRef?: { id: string; sha256: string };
    byteLength?: number;
  }): void | Promise<void>;
  /** Presentation-only liveness for the provider request currently in flight. */
  modelRoundWaitingChanged?(update: {
    turnId: string;
    requestId: string;
    status: "started" | "completed" | "failed" | "cancelled";
    modelRef?: string;
  }): void | Promise<void>;
  operationalNoticeChanged?(update: {
    turnId: string;
    semanticState: string;
    status: "recovering" | "interrupted" | "cleared";
    code?: string;
    activationKind?: "automatic_storage_recovery" | "cancelled";
  }): void | Promise<void>;
}
