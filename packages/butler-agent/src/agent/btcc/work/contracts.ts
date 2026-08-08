export type WorkStage =
  | "conception"
  | "planning"
  | "execution"
  | "review"
  | "validation"
  | "reporting";

export type WorkTurnScope = {
  turnId: string;
  sessionId: string;
  projectRef?: string;
};

export type DurableWorkScope =
  | { kind: "session"; sessionId: string }
  | { kind: "project"; projectRef: string };

export type DurableWorkPlanAction = {
  actionKey: string;
  description: string;
  dependencyKeys: string[];
  effect?: {
    capability: string;
    target: string;
  };
};

export type DurableWorkActionStatus =
  | "pending"
  | "active"
  | "done"
  | "blocked"
  | "skipped";

export type DurableWorkActionProgress = {
  actionKey: string;
  status: DurableWorkActionStatus;
  note?: string;
};

export type DurableWorkActionUpdate = DurableWorkActionProgress;

export type DurableWorkPlan = {
  planRevisionId: string;
  revision: number;
  objective: string;
  governingRefs?: string[];
  actions: DurableWorkPlanAction[];
  checks: string[];
  originTurnId: string;
  createdAt: string;
};

export type DurableWorkToolResultRef = {
  resultRef: string;
  toolCallId: string;
  toolName: string;
  status: "completed" | "failed" | "cancelled";
  resultSha256?: string;
  errorCode?: string;
  originTurnId: string;
  attachedAt: string;
};

export type DurableWorkCheckpoint = {
  checkpointRevisionId: string;
  revision: number;
  planRevisionId: string;
  stage: WorkStage;
  actionProgress: DurableWorkActionProgress[];
  publicSummary: string;
  nextStep: string;
  referencedResultRefs: string[];
  originTurnId: string;
  createdAt: string;
};

export type DurableWorkReview = {
  reviewRevisionId: string;
  revision: number;
  subject: "plan" | "result" | "completion";
  verdict: "accept" | "revise" | "partial";
  summary: string;
  corrections: string[];
  boundPlanRevisionId?: string;
  boundResultReviewRevisionId?: string;
  boundActionProgress?: DurableWorkActionProgress[];
  boundResultRefs: string[];
  originTurnId: string;
  createdAt: string;
};

export type DurableWorkEffectBlocker = {
  blockerId: string;
  sourceTurnId: string;
  capability: string;
  target: string;
  detail: string;
  createdAt: string;
};

export type DurableWorkView = {
  workId: string;
  sessionId: string;
  scope: DurableWorkScope;
  origin: {
    turnId: string;
    messageId: string;
  };
  objective: string;
  status: "open" | "blocked" | "completed" | "abandoned";
  currentStage?: WorkStage;
  allowedNextStages: WorkStage[];
  actionProgress: DurableWorkActionProgress[];
  currentPlan?: DurableWorkPlan;
  latestCheckpoint?: DurableWorkCheckpoint;
  latestPlanReview?: DurableWorkReview;
  latestResultReview?: DurableWorkReview;
  latestCompletionValidation?: DurableWorkReview;
  effectBlockers?: DurableWorkEffectBlocker[];
  resultRefs: DurableWorkToolResultRef[];
  createdAt: string;
  updatedAt: string;
};

export type DurableWorkContext = {
  work: DurableWorkView;
  originalRequest: {
    turnId: string;
    messageId: string;
    content: string;
  };
  resultFacts: Array<{
    toolName: string;
    status: "completed" | "failed" | "cancelled";
    resultJson?: unknown;
    errorCode?: string;
  }>;
};

export type ReplaceWorkPlanInput = WorkTurnScope & {
  mutationCallId: string;
  startNew?: boolean;
  /** Runtime-only IDs of completed Turn-local results to attach atomically. */
  backfillToolCallIds?: string[];
  objective: string;
  governingRefs?: string[];
  actions: DurableWorkPlanAction[];
  checks: string[];
};

export type StartWorkInput = WorkTurnScope & {
  mutationCallId: string;
  objective: string;
  /** Runtime-only IDs of completed Turn-local results to attach atomically. */
  backfillToolCallIds?: string[];
};

export type ContinueWorkInput = WorkTurnScope & {
  mutationCallId: string;
  workId: string;
  /** Runtime-only IDs of completed Turn-local results to attach atomically. */
  backfillToolCallIds?: string[];
};

export type RecordWorkCheckpointInput = WorkTurnScope & {
  mutationCallId: string;
  nextStage?: WorkStage;
  actionUpdates?: DurableWorkActionUpdate[];
  publicSummary?: string;
  nextStep?: string;
};

export type RecordWorkReviewInput = WorkTurnScope & {
  mutationCallId: string;
  subject: "plan" | "result" | "completion";
  verdict: "accept" | "revise" | "partial";
  summary: string;
  corrections: string[];
  actionUpdates?: DurableWorkActionUpdate[];
  nextStage?: WorkStage;
};

export type AttachToolResultInput = WorkTurnScope & {
  mutationCallId: string;
  toolCallId: string;
};

export type LegacyOpenWorkImportResult = {
  sourceProgramId: string;
  imported: boolean;
  work: DurableWorkView;
};

export type ReplaceWorkPlanCommand = Omit<
  ReplaceWorkPlanInput,
  "startNew" | "governingRefs"
> & {
  startNew: boolean;
  requestSha256: string;
  governingRefs: string[];
  expectedWorkId?: string;
  expectedProgressRevision?: number;
  actionProgress: DurableWorkActionProgress[];
  openingPlan: boolean;
};

export type StartWorkCommand = StartWorkInput & {
  requestSha256: string;
};

export type ContinueWorkCommand = ContinueWorkInput & {
  requestSha256: string;
};

export type RecordWorkCheckpointCommand = Omit<
  RecordWorkCheckpointInput,
  "nextStage" | "actionUpdates" | "publicSummary" | "nextStep"
> & {
  expectedPlanRevisionId: string;
  expectedProgressRevision: number;
  requestSha256: string;
  stage: WorkStage;
  actionProgress: DurableWorkActionProgress[];
  publicSummary: string;
  nextStep: string;
};

export type RecordWorkReviewCommand = RecordWorkReviewInput & {
  expectedPlanRevisionId: string;
  expectedProgressRevision: number;
  expectedResultSequence: number;
  expectedResultReviewRevisionId?: string;
  requestSha256: string;
  currentStage: WorkStage;
  entryStage: "review" | "validation";
  actionProgress: DurableWorkActionProgress[];
  progressChanged: boolean;
  completeWork: boolean;
};

export interface DurableWorkService {
  loadContext(scope: WorkTurnScope): Promise<DurableWorkContext | null>;
  importOpenLegacyWork(
    scope: WorkTurnScope,
  ): Promise<LegacyOpenWorkImportResult | null>;
  startWork(input: StartWorkInput): Promise<DurableWorkView>;
  continueWork(input: ContinueWorkInput): Promise<DurableWorkView>;
  replacePlan(input: ReplaceWorkPlanInput): Promise<DurableWorkView>;
  recordCheckpoint(input: RecordWorkCheckpointInput): Promise<DurableWorkView>;
  recordReview(input: RecordWorkReviewInput): Promise<DurableWorkView>;
  attachToolResult(input: AttachToolResultInput): Promise<DurableWorkView>;
  boundWorkForTurn(turnId: string): Promise<DurableWorkView | null>;
}

export interface DurableWorkStore {
  loadContext(scope: WorkTurnScope): Promise<DurableWorkContext | null>;
  importOpenLegacyWork(
    scope: WorkTurnScope,
  ): Promise<LegacyOpenWorkImportResult | null>;
  startWork(input: StartWorkCommand): Promise<DurableWorkView>;
  continueWork(input: ContinueWorkCommand): Promise<DurableWorkView>;
  replacePlan(input: ReplaceWorkPlanCommand): Promise<DurableWorkView>;
  recordCheckpoint(input: RecordWorkCheckpointCommand): Promise<DurableWorkView>;
  recordReview(input: RecordWorkReviewCommand): Promise<DurableWorkView>;
  attachToolResult(input: AttachToolResultInput): Promise<DurableWorkView>;
  boundWorkForTurn(turnId: string): Promise<DurableWorkView | null>;
}
