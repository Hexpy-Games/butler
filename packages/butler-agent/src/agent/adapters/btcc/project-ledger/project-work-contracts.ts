import type {
  DurableWorkActionProgress,
  DurableWorkContext,
  DurableWorkCheckpoint,
  DurableWorkDisposition,
  DurableWorkPlan,
  DurableWorkReview,
  DurableWorkToolResultRef,
  DurableWorkView,
  RecordWorkDispositionCommand,
  WorkTurnScope,
} from "../../../btcc/work/index.ts";
import type { ProjectWorkMaterialSnapshot } from "./project-work-material-snapshot.ts";

export type ResolvedProjectWorkScope = {
  appProjectId: string;
  ledgerProjectId: string;
  ledgerRoot: string;
};

export type ProjectWorkOperationIdentity = {
  kind:
    | "mutation_call"
    | "binding_revision"
    | "closeout_diagnostic"
    | "abandonment"
    | "legacy_import";
  id: string;
  requestSha256: string;
  mutationCallId?: string;
};

export type ProjectWorkLegacySnapshot = {
  sourceKind: "sqlite_r3" | "raw_r2";
  sourceProgramId: string;
  /** Complete Session locator set used by the legacy source selector. */
  sourceProgramIds: string[];
  sourceIdentity: string;
  sourceSha256: string;
  work: DurableWorkView;
  plans: DurableWorkPlan[];
  checkpoints: Array<{
    checkpoint: DurableWorkCheckpoint;
    fromResultSequence: number;
    toResultSequence: number;
  }>;
  reviews: DurableWorkReview[];
  dispositions: Array<{
    disposition: DurableWorkDisposition;
    historicalView: DurableWorkView;
    effectWatermark: string;
  }>;
  bindings: Array<{
    bindingRevisionId: string;
    turnId: string;
    revision: number;
    boundAt: string;
    isCurrent: boolean;
  }>;
  turns: Array<{
    turnId: string;
    sessionId: string;
    originalMessageId: string;
    originalMessage: string;
    semanticState: string;
    executionFence: number;
  }>;
};

export type ProjectWorkLegacyObservation = {
  sourceProgramId: string;
  sourceSha256: string;
  workId: string;
};

/** Owns the bounded SQLite snapshot and post-promotion fixed-point cleanup. */
export type ProjectWorkLegacyRuntime = {
  readImportObservation(input: {
    scope: WorkTurnScope;
    resolvedScope: ResolvedProjectWorkScope;
  }): ProjectWorkLegacyObservation | null;
  captureStableSnapshot(input: {
    scope: WorkTurnScope;
    resolvedScope: ResolvedProjectWorkScope;
  }): ProjectWorkLegacySnapshot | null | Promise<ProjectWorkLegacySnapshot | null>;
  /** Re-read non-SQLite legacy input after publication and before cleanup. */
  revalidateBeforeObservation(input: {
    scope: WorkTurnScope;
    resolvedScope: ResolvedProjectWorkScope;
    snapshot: ProjectWorkLegacySnapshot;
  }): Promise<void>;
  observeImported(input: {
    scope: WorkTurnScope;
    resolvedScope: ResolvedProjectWorkScope;
    snapshot: ProjectWorkLegacySnapshot;
    canonicalHeadSha256: string;
    verifyResults(): void;
  }): void;
};

export type ProjectWorkRuntimeProjection = {
  locateCanonicalWorks(input: {
    scope: ResolvedProjectWorkScope;
    sessionId?: string;
    turnId?: string;
  }): Promise<{
    sessionHeadWorkId: string | null;
    bindingWorkId: string | null;
  }>;
  loadOriginalRequest(
    scope: WorkTurnScope,
  ): Promise<DurableWorkContext["originalRequest"]>;
  loadResultFacts(workId: string): Promise<DurableWorkContext["resultFacts"]>;
  operationRecordedAt(identity: ProjectWorkOperationIdentity): Promise<string>;
  prepareDisposition(input: {
    command: RecordWorkDispositionCommand;
    current: DurableWorkView;
  }): Promise<
    | { mode: "current_view" }
    | {
        mode: "apply";
        actionProgress: DurableWorkActionProgress[];
        evidenceSnapshot: string[];
      }
  >;
  captureWorkMaterial(input: {
    operationIdentity: ProjectWorkOperationIdentity;
    current: DurableWorkView | null;
    candidate: DurableWorkView;
  }): Promise<{
    materialFingerprint: string;
    materialSnapshot: ProjectWorkMaterialSnapshot;
  }>;
  observeCanonicalWorks(input: {
    works: Array<{
      work: DurableWorkView;
      bindings: Array<{
        bindingRevisionId: string;
        turnId: string;
        revision: number;
        boundAt: string;
        isCurrent: boolean;
      }>;
    }>;
    sessionHeadWorkId: string;
    ledgerProjectId: string;
    canonicalHeadSha256: string;
    legacyImportClaimWorkId?: string;
  }): Promise<void>;
};

export type ProjectWorkToolResultEvidence = {
  toolCallId: string;
  toolName: string;
  status: "completed";
  resultSha256: string;
  originTurnId: string;
  sourceTurnRowid: number | null;
  sourceTurnSequence: number | null;
};

/** SQLite remains the raw-result authority and receives only a thin Project link. */
export type ProjectWorkResultRuntime = {
  readCommittedResult(input: {
    turnId: string;
    sessionId: string;
    toolCallId: string;
  }): ProjectWorkToolResultEvidence;
  observeCanonicalResult(input: {
    work: DurableWorkView;
    scope: ResolvedProjectWorkScope;
    result: DurableWorkToolResultRef & { sequence: number };
    operationIdentity: ProjectWorkOperationIdentity;
  }): void;
};

export type CreateProjectWorkStoreInput = {
  butlerData: string;
  scope: ResolvedProjectWorkScope;
  runtimeProjection: ProjectWorkRuntimeProjection;
  resultRuntime: ProjectWorkResultRuntime;
  legacyRuntime?: ProjectWorkLegacyRuntime;
};
