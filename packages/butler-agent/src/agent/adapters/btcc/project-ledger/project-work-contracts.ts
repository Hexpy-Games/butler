import type {
  AttachToolResultInput,
  DurableWorkActionProgress,
  DurableWorkContext,
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
      currentBindingTurnIds: string[];
    }>;
    sessionHeadWorkId: string;
  }): Promise<void>;
};

export type ProjectWorkResultAttachment = {
  attachToolResult(input: AttachToolResultInput): Promise<DurableWorkView>;
};

export type CreateProjectWorkStoreInput = {
  butlerData: string;
  scope: ResolvedProjectWorkScope;
  runtimeProjection: ProjectWorkRuntimeProjection;
  resultAttachment: ProjectWorkResultAttachment;
};
