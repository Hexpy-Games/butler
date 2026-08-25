import type {
  DurableWorkCheckpoint,
  DurableWorkView,
  WorkTurnScope,
} from "../../../btcc/work/index.ts";
import type { ProjectLedgerRecordUpdate } from "./external-effect-record-update.ts";
import type { ProjectWorkChild } from "./project-work-child-codec.ts";
import {
  officialWorkStatus,
  PROJECT_WORK_SPEC,
  type ProjectWorkManifest,
} from "./project-work-codec.ts";
import { canonicalJson, projectWorkRecordId, workPath } from "./project-work-json.ts";
import type {
  ProjectWorkOperationIdentity,
  ResolvedProjectWorkScope,
} from "./project-work-contracts.ts";
import type { CurrentProjectWorkSnapshot } from "./project-work-snapshot.ts";

export function manifestForView(input: {
  prior?: ProjectWorkManifest;
  view: DurableWorkView;
  scope: ResolvedProjectWorkScope;
  operationIdentity: ProjectWorkManifest["operationIdentity"];
  bindingRefs: ProjectWorkManifest["bindingRefs"];
  sessionHead?: boolean;
  material: {
    materialFingerprint: string;
    materialSnapshot: ProjectWorkManifest["materialSnapshot"];
  };
  revisions: Pick<
    ProjectWorkManifest,
    | "planRevision"
    | "checkpointRevision"
    | "checkpointResultSequence"
    | "reviewRevision"
    | "dispositionRevision"
  >;
}): ProjectWorkManifest {
  const view = input.view;
  return {
    schema: "butler.btcc-project-work.v1",
    workId: view.workId,
    sessionId: view.sessionId,
    scope: {
      appProjectId: input.scope.appProjectId,
      ledgerProjectId: input.scope.ledgerProjectId,
    },
    origin: view.origin,
    objective: view.objective,
    status: view.status,
    sessionHead: input.sessionHead ?? input.prior?.sessionHead ?? true,
    ...(view.currentStage ? { currentStage: view.currentStage } : {}),
    allowedNextStages: view.allowedNextStages,
    actionProgress: view.actionProgress,
    ...(view.currentPlan
      ? { currentPlanRevisionId: view.currentPlan.planRevisionId }
      : {}),
    ...(view.latestCheckpoint
      ? {
          latestCheckpointRevisionId:
            view.latestCheckpoint.checkpointRevisionId,
        }
      : {}),
    ...(view.latestPlanReview
      ? { latestPlanReviewRevisionId: view.latestPlanReview.reviewRevisionId }
      : {}),
    ...(view.latestResultReview
      ? {
          latestResultReviewRevisionId:
            view.latestResultReview.reviewRevisionId,
        }
      : {}),
    ...(view.latestCompletionValidation
      ? {
          latestCompletionValidationRevisionId:
            view.latestCompletionValidation.reviewRevisionId,
        }
      : {}),
    ...(view.latestDisposition
      ? {
          latestDispositionRevisionId:
            view.latestDisposition.dispositionRevisionId,
        }
      : {}),
    resultRefs: view.resultRefs,
    bindingRefs: input.bindingRefs,
    ...input.revisions,
    resultSequence: view.resultRefs.length,
    materialFingerprint: input.material.materialFingerprint,
    materialSnapshot: input.material.materialSnapshot,
    operationIdentity: input.operationIdentity,
    createdAt: input.prior?.createdAt ?? view.createdAt,
    updatedAt: view.updatedAt,
  };
}

export function mutableWorkUpdate(
  manifest: ProjectWorkManifest,
  create: boolean,
): ProjectLedgerRecordUpdate {
  return {
    operation: create ? "create" : "update",
    kind: "work",
    id: manifest.workId,
    title: `Guided Work ${manifest.workId}`,
    status: officialWorkStatus(manifest.status),
    spec: PROJECT_WORK_SPEC,
    body: canonicalJson(manifest),
  };
}

export function workTarget(scope: ResolvedProjectWorkScope, workId: string) {
  return {
    id: workId,
    kind: "work",
    parentId: null,
    path: workPath(scope.ledgerProjectId, workId),
  };
}

export function bindingChild(
  scope: WorkTurnScope,
  workId: string,
  revision: number,
  identity: ProjectWorkOperationIdentity,
  at: string,
): Extract<
  ProjectWorkChild,
  { schema: "butler.btcc-project-work-binding.v1" }
> {
  return {
    schema: "butler.btcc-project-work-binding.v1",
    workId,
    operationIdentity: identity,
    binding: {
      bindingRevisionId: projectWorkRecordId(
        "binding",
        `${scope.turnId}\0${revision}\0${workId}`,
      ),
      turnId: scope.turnId,
      sessionId: scope.sessionId,
      revision,
      boundAt: at,
    },
  };
}

export function checkpointChild(
  current: CurrentProjectWorkSnapshot,
  command: {
    turnId: string;
    actionProgress: DurableWorkView["actionProgress"];
    publicSummary?: string;
    nextStep?: string;
  },
  identity: ProjectWorkOperationIdentity,
  at: string,
  revision: number,
  stage: DurableWorkCheckpoint["stage"],
  checkpointIdentity: string,
  planRevisionId: string,
): Extract<
  ProjectWorkChild,
  { schema: "butler.btcc-project-work-checkpoint.v1" }
> {
  return {
    schema: "butler.btcc-project-work-checkpoint.v1",
    workId: current.view.workId,
    operationIdentity: identity,
    checkpointIdentity,
    resultWindow: {
      fromSequence: 0,
      toSequence: current.view.resultRefs.length,
    },
    checkpoint: {
      checkpointRevisionId: projectWorkRecordId(
        "checkpoint",
        checkpointIdentity,
      ),
      revision,
      planRevisionId,
      stage,
      actionProgress: command.actionProgress,
      publicSummary: command.publicSummary ?? current.view.objective,
      nextStep: command.nextStep ?? "",
      referencedResultRefs: current.view.resultRefs
        .slice(0)
        .map((item) => item.resultRef),
      originTurnId: command.turnId,
      createdAt: at,
    },
  };
}

export function childItem(child: ProjectWorkChild): {
  id: string;
  kind: "plan" | "reference";
  title: string;
} {
  if (child.schema === "butler.btcc-project-work-plan.v1")
    return {
      id: child.plan.planRevisionId,
      kind: "plan",
      title: `Guided Work Plan ${child.plan.revision}`,
    };
  if (child.schema === "butler.btcc-project-work-checkpoint.v1")
    return {
      id: child.checkpoint.checkpointRevisionId,
      kind: "reference",
      title: `Guided Work checkpoint ${child.checkpoint.revision}`,
    };
  if (child.schema === "butler.btcc-project-work-review.v1")
    return {
      id: child.review.reviewRevisionId,
      kind: "reference",
      title: `Guided Work ${child.review.subject} Review`,
    };
  if (child.schema === "butler.btcc-project-work-disposition.v1")
    return {
      id: child.disposition.dispositionRevisionId,
      kind: "reference",
      title: `Guided Work disposition ${child.disposition.revision}`,
    };
  if (child.schema === "butler.btcc-project-work-result-reference.v1")
    return {
      id: child.result.resultRef,
      kind: "reference",
      title: `Guided Work Result ${child.result.sequence}`,
    };
  if (child.schema === "butler.btcc-project-work-binding.v1")
    return {
      id: child.binding.bindingRevisionId,
      kind: "reference",
      title: `Guided Work Turn binding ${child.binding.revision}`,
    };
  return {
    id: child.diagnostic.diagnosticId,
    kind: "reference",
    title: "Guided Work closeout diagnostic",
  };
}

export function statusForProgress(
  progress: DurableWorkView["actionProgress"],
): "open" | "blocked" {
  return progress.some((item) => item.status === "blocked")
    ? "blocked"
    : "open";
}
