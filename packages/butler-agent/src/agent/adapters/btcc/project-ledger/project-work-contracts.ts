import type {
  AttachToolResultInput,
  DurableWorkActionProgress,
  DurableWorkContext,
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
    | "abandonment";
  id: string;
  requestSha256: string;
  mutationCallId?: string;
};

export type ProjectWorkRuntimeProjection = {
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
  readCommittedResult(input: AttachToolResultInput): ProjectWorkToolResultEvidence;
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
};
