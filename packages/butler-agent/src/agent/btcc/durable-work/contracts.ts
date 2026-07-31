export type WorkStage =
  | "conception"
  | "planning"
  | "execution"
  | "review"
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

export type DurableWorkPlan = {
  planRevisionId: string;
  revision: number;
  objective: string;
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
  stage: WorkStage;
  publicSummary: string;
  nextStep: string;
  referencedResultRefs: string[];
  originTurnId: string;
  createdAt: string;
};

export type DurableWorkReview = {
  reviewRevisionId: string;
  revision: number;
  subject: "plan" | "result";
  verdict: "accept" | "revise" | "partial";
  summary: string;
  corrections: string[];
  boundPlanRevisionId?: string;
  boundResultRefs: string[];
  originTurnId: string;
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
  currentPlan?: DurableWorkPlan;
  latestCheckpoint?: DurableWorkCheckpoint;
  latestPlanReview?: DurableWorkReview;
  latestResultReview?: DurableWorkReview;
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
  objective: string;
  actions: DurableWorkPlanAction[];
  checks: string[];
};

export type RecordWorkCheckpointInput = WorkTurnScope & {
  mutationCallId: string;
  stage: WorkStage;
  publicSummary: string;
  nextStep: string;
};

export type RecordWorkReviewInput = WorkTurnScope & {
  mutationCallId: string;
  subject: "plan" | "result";
  verdict: "accept" | "revise" | "partial";
  summary: string;
  corrections: string[];
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

export type ReplaceWorkPlanCommand = Omit<ReplaceWorkPlanInput, "startNew"> & {
  startNew: boolean;
};

export type RecordWorkReviewCommand = RecordWorkReviewInput & {
  completeWork: boolean;
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
  bindOpenWork(
    scope: WorkTurnScope,
    expectedWorkId?: string,
  ): Promise<DurableWorkView | null>;
  replacePlan(input: ReplaceWorkPlanCommand): Promise<DurableWorkView>;
  recordCheckpoint(input: RecordWorkCheckpointInput): Promise<DurableWorkView>;
  recordReview(input: RecordWorkReviewCommand): Promise<DurableWorkView>;
  attachToolResult(input: AttachToolResultInput): Promise<DurableWorkView>;
  boundWorkForTurn(turnId: string): Promise<DurableWorkView | null>;
}
