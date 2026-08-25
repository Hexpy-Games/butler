import type {
  DurableWorkCheckpoint,
  DurableWorkPlan,
  DurableWorkView,
} from "../../../btcc/work/index.ts";
import { stableJson } from "../../../btcc/identity/index.ts";
import type { ProjectWorkChild } from "./project-work-child-codec.ts";
import type { ProjectWorkOperationIdentity } from "./project-work-contracts.ts";
import type { CurrentProjectWorkSnapshot } from "./project-work-snapshot.ts";

type RawMutation = Record<string, unknown> & { turnId: string };

/** Reconstructs the exact pre-operation B1 context from immutable operation children. */
export function projectWorkReplayContext(
  current: CurrentProjectWorkSnapshot,
  operation: string,
  raw: RawMutation,
  identity: ProjectWorkOperationIdentity,
): DurableWorkView {
  const children = operationChildren(current.children, identity);
  if (operation === "replace_plan")
    return planReplayContext(current, children, raw);
  if (operation === "record_checkpoint")
    return checkpointReplayContext(current, children, raw);
  return reviewReplayContext(current, children, raw);
}

export function operationChildren(
  children: ProjectWorkChild[],
  identity: ProjectWorkOperationIdentity,
): ProjectWorkChild[] {
  const sameId = children.filter(
    (child) =>
      child.operationIdentity.kind === identity.kind &&
      child.operationIdentity.id === identity.id,
  );
  if (
    sameId.length === 0 ||
    sameId.some(
      (child) =>
        child.operationIdentity.mutationCallId !== identity.mutationCallId ||
        child.operationIdentity.requestSha256 !== identity.requestSha256,
    )
  )
    invalid();
  return sameId;
}

function planReplayContext(
  current: CurrentProjectWorkSnapshot,
  children: ProjectWorkChild[],
  raw: RawMutation,
): DurableWorkView {
  const child = only(children, "butler.btcc-project-work-plan.v1");
  const plan = child.plan;
  if (
    plan.objective !== raw.objective ||
    stableJson(plan.actions) !== stableJson(raw.actions) ||
    stableJson(plan.checks) !== stableJson(raw.checks) ||
    stableJson(plan.governingRefs ?? []) !==
      stableJson(raw.governingRefs ?? []) ||
    plan.originTurnId !== raw.turnId
  )
    invalid();
  const operationCheckpoints = checkpoints(children);
  const prior = checkpointBefore(current.children, operationCheckpoints);
  const priorPlanChild = current.children.find(
    (item) =>
      item.schema === "butler.btcc-project-work-plan.v1" &&
      item.plan.revision === plan.revision - 1,
  );
  const priorPlan =
    priorPlanChild?.schema === "butler.btcc-project-work-plan.v1"
      ? priorPlanChild.plan
      : undefined;
  return historicalView(
    current.view,
    priorPlan,
    prior,
    operationCheckpoints[0]?.checkpoint.referencedResultRefs ?? [],
  );
}

function checkpointReplayContext(
  current: CurrentProjectWorkSnapshot,
  children: ProjectWorkChild[],
  raw: RawMutation,
): DurableWorkView {
  const child = only(children, "butler.btcc-project-work-checkpoint.v1");
  const checkpoint = child.checkpoint;
  if (
    child.checkpointIdentity !== child.operationIdentity.id ||
    checkpoint.originTurnId !== raw.turnId ||
    checkpoint.publicSummary !== String(raw.publicSummary ?? "").trim() ||
    checkpoint.nextStep !== String(raw.nextStep ?? "").trim()
  )
    invalid();
  const prior = checkpointBefore(current.children, [child]);
  const plan = planById(current.children, checkpoint.planRevisionId);
  return historicalView(
    current.view,
    plan,
    prior,
    checkpoint.referencedResultRefs,
  );
}

function reviewReplayContext(
  current: CurrentProjectWorkSnapshot,
  children: ProjectWorkChild[],
  raw: RawMutation,
): DurableWorkView {
  const child = only(children, "butler.btcc-project-work-review.v1");
  const review = child.review;
  if (
    review.originTurnId !== raw.turnId ||
    review.subject !== raw.subject ||
    review.verdict !== raw.verdict ||
    review.summary !== raw.summary ||
    stableJson(review.corrections) !== stableJson(raw.corrections)
  )
    invalid();
  const operationCheckpoints = checkpoints(children);
  const prior = checkpointBefore(current.children, operationCheckpoints);
  const planId =
    operationCheckpoints[0]?.checkpoint.planRevisionId ??
    review.boundPlanRevisionId;
  const plan = planId ? planById(current.children, planId) : undefined;
  const view = historicalView(current.view, plan, prior, review.boundResultRefs);
  if (!review.boundResultReviewRevisionId) return view;
  const bound = current.children.find(
    (item) =>
      item.schema === "butler.btcc-project-work-review.v1" &&
      item.review.reviewRevisionId === review.boundResultReviewRevisionId,
  );
  if (!bound || bound.schema !== "butler.btcc-project-work-review.v1")
    invalid();
  return { ...view, latestResultReview: bound.review };
}

function historicalView(
  current: DurableWorkView,
  plan: DurableWorkPlan | undefined,
  checkpoint: DurableWorkCheckpoint | undefined,
  resultIds: string[],
): DurableWorkView {
  return {
    ...current,
    status: "open",
    objective: plan?.objective ?? current.objective,
    ...(plan ? { currentPlan: plan } : { currentPlan: undefined }),
    ...(checkpoint
      ? {
          latestCheckpoint: checkpoint,
          currentStage: checkpoint.stage,
          actionProgress: checkpoint.actionProgress,
        }
      : {
          latestCheckpoint: undefined,
          currentStage: undefined,
          actionProgress: [],
        }),
    resultRefs: current.resultRefs.filter((result) =>
      resultIds.includes(result.resultRef),
    ),
  };
}

function checkpointBefore(
  all: ProjectWorkChild[],
  operation: CheckpointChild[],
): DurableWorkCheckpoint | undefined {
  const first = Math.min(...operation.map((child) => child.checkpoint.revision));
  if (!Number.isFinite(first)) invalid();
  const prior = all.find(
    (child) =>
      child.schema === "butler.btcc-project-work-checkpoint.v1" &&
      child.checkpoint.revision === first - 1,
  );
  return prior?.schema === "butler.btcc-project-work-checkpoint.v1"
    ? prior.checkpoint
    : undefined;
}

function checkpoints(children: ProjectWorkChild[]): CheckpointChild[] {
  return children
    .filter(
      (child) => child.schema === "butler.btcc-project-work-checkpoint.v1",
    )
    .sort(
      (left, right) => left.checkpoint.revision - right.checkpoint.revision,
    );
}

function planById(children: ProjectWorkChild[], id: string) {
  const child = children.find(
    (item) =>
      item.schema === "butler.btcc-project-work-plan.v1" &&
      item.plan.planRevisionId === id,
  );
  if (!child || child.schema !== "butler.btcc-project-work-plan.v1") invalid();
  return child.plan;
}

function only<T extends ProjectWorkChild["schema"]>(
  children: ProjectWorkChild[],
  schema: T,
): Extract<ProjectWorkChild, { schema: T }> {
  const matches = children.filter((child) => child.schema === schema);
  if (matches.length !== 1) invalid();
  return matches[0] as Extract<ProjectWorkChild, { schema: T }>;
}

type CheckpointChild = Extract<
  ProjectWorkChild,
  { schema: "butler.btcc-project-work-checkpoint.v1" }
>;

function invalid(): never {
  throw new Error("project_work_managed_record_invalid");
}
