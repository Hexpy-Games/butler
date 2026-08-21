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

export type DurableWorkDispositionStatus = "completed" | "open" | "blocked";

export type DurableWorkDispositionActionUpdate = {
  actionKey: string;
  status: "done" | "skipped" | "blocked";
  note?: string;
};

export type DurableWorkDisposition = {
  dispositionRevisionId: string;
  revision: number;
  /** Work-result sequence observed by the atomic closeout. */
  resultSequence: number;
  /** Internal immutable snapshot used to reject stale closeout candidates. */
  materialFingerprint: string;
  /** Persisted provenance for deterministic notice replay before Turn delivery. */
  runtimeOwnedOpen: boolean;
  disposition: DurableWorkDispositionStatus;
  summary: string;
  actionUpdates: DurableWorkDispositionActionUpdate[];
  remainingActions: string[];
  nextCondition?: string;
  evidenceRefs: string[];
  /** Durable result refs captured after current-Turn backfill. */
  evidenceSnapshot: string[];
  followups: string[];
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
  latestDisposition?: DurableWorkDisposition;
  /** Internal freshness watermark for closeout reconciliation. */
  effectWatermark?: string;
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

export type WorkCorrectionScope = "planning" | "execution";

export type RecordWorkReviewInput = WorkTurnScope & {
  mutationCallId: string;
  subject: "plan" | "result" | "completion";
  verdict: "accept" | "revise" | "partial";
  summary: string;
  corrections: string[];
  actionUpdates?: DurableWorkActionUpdate[];
  correctionScope?: WorkCorrectionScope;
  nextStage?: WorkStage;
};

export type AttachToolResultInput = WorkTurnScope & {
  mutationCallId: string;
  toolCallId: string;
};

export type RecordWorkDispositionInput = WorkTurnScope & {
  mutationCallId: string;
  workId: string;
  disposition: DurableWorkDispositionStatus;
  summary: string;
  actionUpdates?: DurableWorkDispositionActionUpdate[];
  remainingActions?: string[];
  nextCondition?: string;
  evidenceRefs?: string[];
  followups?: string[];
  /** Runtime-only current-Turn completed calls to attach atomically. */
  backfillToolCallIds?: string[];
  /** Material Work snapshot expected immediately after atomic Turn backfill. */
  expectedMaterialFingerprint?: string;
  /** Marks the deterministic runtime-owned open generation; never model input. */
  runtimeOwnedOpenGeneration?: Readonly<{ version: 1 }>;
};

export type ClaimWorkCloseoutCorrectionInput = WorkTurnScope & {
  workId: string;
};

export type RecordCloseoutMissingInput = WorkTurnScope & {
  workId: string;
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
  "actionUpdates" | "publicSummary" | "nextStep"
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
  nextStage: WorkStage;
  actionProgress: DurableWorkActionProgress[];
  progressChanged: boolean;
};

export type RecordWorkDispositionCommand = RecordWorkDispositionInput & {
  requestSha256: string;
};

export interface DurableWorkService {
  loadContext(scope: WorkTurnScope): Promise<DurableWorkContext | null>;
  importOpenLegacyWork(
    scope: WorkTurnScope,
  ): Promise<LegacyOpenWorkImportResult | null>;
  bindOpenWork(
    scope: WorkTurnScope,
    expectedWorkId?: string,
  ): Promise<DurableWorkView | null>;
  startWork(input: StartWorkInput): Promise<DurableWorkView>;
  continueWork(input: ContinueWorkInput): Promise<DurableWorkView>;
  replacePlan(input: ReplaceWorkPlanInput): Promise<DurableWorkView>;
  recordCheckpoint(input: RecordWorkCheckpointInput): Promise<DurableWorkView>;
  recordReview(input: RecordWorkReviewInput): Promise<DurableWorkView>;
  recordDisposition(input: RecordWorkDispositionInput): Promise<DurableWorkView>;
  claimCloseoutCorrection(input: ClaimWorkCloseoutCorrectionInput): Promise<boolean>;
  attachToolResult(input: AttachToolResultInput): Promise<DurableWorkView>;
  boundWorkForTurn(turnId: string): Promise<DurableWorkView | null>;
  abandonBoundWorkForTurn(turnId: string): Promise<DurableWorkView | null>;
}

export interface DurableWorkStore {
  loadContext(scope: WorkTurnScope): Promise<DurableWorkContext | null>;
  importOpenLegacyWork(
    scope: WorkTurnScope,
  ): Promise<LegacyOpenWorkImportResult | null>;
  bindOpenWork(
    scope: WorkTurnScope,
    expectedWorkId?: string,
  ): Promise<DurableWorkView | null>;
  startWork(input: StartWorkCommand): Promise<DurableWorkView>;
  continueWork(input: ContinueWorkCommand): Promise<DurableWorkView>;
  replacePlan(input: ReplaceWorkPlanCommand): Promise<DurableWorkView>;
  recordCheckpoint(input: RecordWorkCheckpointCommand): Promise<DurableWorkView>;
  recordReview(input: RecordWorkReviewCommand): Promise<DurableWorkView>;
  recordDisposition(input: RecordWorkDispositionCommand): Promise<DurableWorkView>;
  claimCloseoutCorrection(input: ClaimWorkCloseoutCorrectionInput): Promise<boolean>;
  attachToolResult(input: AttachToolResultInput): Promise<DurableWorkView>;
  boundWorkForTurn(turnId: string): Promise<DurableWorkView | null>;
  abandonBoundWorkForTurn(turnId: string): Promise<DurableWorkView | null>;
}
