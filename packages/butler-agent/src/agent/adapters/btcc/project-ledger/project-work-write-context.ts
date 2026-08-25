import type {
  DurableWorkView,
  WorkTurnScope,
} from "../../../btcc/work/index.ts";
import type { ProjectLedgerRecordUpdate } from "./external-effect-record-update.ts";
import type { ExactLedgerTargetPrecondition } from "./canonical-ledger-reader.ts";
import type {
  CreateProjectWorkStoreInput,
  ProjectWorkOperationIdentity,
} from "./project-work-contracts.ts";
import type { ProjectWorkManifest } from "./project-work-codec.ts";
import type { ProjectWorkMaterialSnapshot } from "./project-work-material-snapshot.ts";
import type { CanonicalProjectWorkRelation } from "./project-work-relation-snapshot.ts";
import type { CurrentProjectWorkSnapshot } from "./project-work-snapshot.ts";

export type ProjectWorkRevisions = Pick<
  ProjectWorkManifest,
  | "planRevision"
  | "checkpointRevision"
  | "checkpointResultSequence"
  | "reviewRevision"
  | "dispositionRevision"
>;

export interface ProjectWorkWriteContext {
  readonly input: CreateProjectWorkStoreInput;
  assertScope(scope: WorkTurnScope): void;
  currentForScope(
    scope: WorkTurnScope,
  ): Promise<CurrentProjectWorkSnapshot | null>;
  relation(scope: WorkTurnScope): Promise<CanonicalProjectWorkRelation>;
  requireBound(
    scope: WorkTurnScope,
    allowCompleted?: boolean,
  ): Promise<CurrentProjectWorkSnapshot>;
  recordedAt(identity: ProjectWorkOperationIdentity): Promise<string>;
  captureMaterial(
    current: DurableWorkView | null,
    candidate: DurableWorkView,
    identity: ProjectWorkOperationIdentity,
  ): Promise<{
    materialFingerprint: string;
    materialSnapshot: ProjectWorkMaterialSnapshot;
  }>;
  afterMutation(
    current: CurrentProjectWorkSnapshot,
    affected?: CurrentProjectWorkSnapshot[],
  ): Promise<DurableWorkView>;
  publish(
    identity: ProjectWorkOperationIdentity,
    prepareUpdates: () => Promise<ProjectLedgerRecordUpdate[] | null>,
  ): Promise<{
    replayed: boolean;
    skipped: boolean;
    targets: ExactLedgerTargetPrecondition[];
    preparedUpdates: ProjectLedgerRecordUpdate[];
  }>;
}

export function mutationIdentity(command: {
  mutationCallId: string;
  requestSha256: string;
}): ProjectWorkOperationIdentity {
  return {
    kind: "mutation_call",
    id: command.mutationCallId,
    mutationCallId: command.mutationCallId,
    requestSha256: command.requestSha256,
  };
}

export function workRevisions(
  manifest: ProjectWorkManifest,
): ProjectWorkRevisions {
  return {
    planRevision: manifest.planRevision,
    checkpointRevision: manifest.checkpointRevision,
    checkpointResultSequence: manifest.checkpointResultSequence,
    reviewRevision: manifest.reviewRevision,
    dispositionRevision: manifest.dispositionRevision,
  };
}

export function noResultBackfill(ids: string[] | undefined): void {
  if (ids && ids.length > 0)
    throw new Error("project_work_result_attachment_required");
}

export function publishedWorkId(outcome: {
  targets: Array<{ id: string; kind: string; parentId: string | null }>;
}): string | undefined {
  const ids = new Set(
    outcome.targets.flatMap((target) =>
      target.kind === "work"
        ? [target.id]
        : target.parentId
          ? [target.parentId]
          : [],
    ),
  );
  return ids.size === 1 ? [...ids][0] : undefined;
}
