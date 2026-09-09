import type { ProjectWorkChild } from "./project-work-child-codec.ts";
import type { ProjectWorkManifest } from "./project-work-codec.ts";
import { canonicalJson } from "./project-work-json.ts";
import { sameActionKeys } from "./project-work-action-progress.ts";

/** Validates immutable historical relationships without requiring current freshness. */
export function validateManagedProjectWorkRelations(
  manifest: ProjectWorkManifest,
  children: ProjectWorkChild[],
): void {
  const plans = new Map(
    children
      .filter((child) => child.schema === "butler.btcc-project-work-plan.v1")
      .map((child) => [child.plan.planRevisionId, child.plan]),
  );
  const results = children
    .filter(
      (child) =>
        child.schema === "butler.btcc-project-work-result-reference.v1",
    )
    .sort((left, right) => left.result.sequence - right.result.sequence);
  const reviews = new Map(
    children
      .filter(
        (child) => child.schema === "butler.btcc-project-work-review.v1",
      )
      .map((child) => [child.review.reviewRevisionId, child]),
  );
  for (const plan of plans.values()) validatePlan(plan);
  for (const child of children) {
    if (child.schema === "butler.btcc-project-work-checkpoint.v1") {
      validateCheckpoint(child, plans, results);
      validateCheckpointRole(child, children);
    }
    if (child.schema === "butler.btcc-project-work-review.v1")
      validateReview(child, plans, reviews, results);
    if (child.schema === "butler.btcc-project-work-disposition.v1")
      validateDisposition(child, manifest, plans, reviews, results);
  }
  validateReviewPointers(manifest, [...reviews.values()], results);
}

function validateReviewPointers(
  manifest: ProjectWorkManifest,
  reviews: ReviewChild[],
  results: ResultChild[],
): void {
  const pointers = {
    plan: manifest.latestPlanReviewRevisionId,
    result: manifest.latestResultReviewRevisionId,
    completion: manifest.latestCompletionValidationRevisionId,
  };
  for (const subject of ["plan", "result", "completion"] as const) {
    const historical = reviews
      .filter((child) => child.review.subject === subject)
      .sort((left, right) => right.review.revision - left.review.revision)[0];
    const pointer = pointers[subject];
    if (!historical) {
      if (pointer !== undefined) invalid();
      continue;
    }
    if (pointer === historical.review.reviewRevisionId) continue;
    const latestResult = results.at(-1);
    if (
      subject === "plan" || pointer !== undefined || !latestResult ||
      latestResult.result.sequence !== manifest.resultSequence ||
      historical.boundResultSequence >= manifest.resultSequence
    ) invalid();
  }
}

function validatePlan(plan: ExtractPlan): void {
  const keys = plan.actions.map(({ actionKey }) => actionKey);
  if (new Set(keys).size !== keys.length) invalid();
  for (const action of plan.actions)
    if (
      action.dependencyKeys.some(
        (dependency) =>
          dependency === action.actionKey || !keys.includes(dependency),
      )
    )
      invalid();
}

function validateCheckpoint(
  child: Extract<
    ProjectWorkChild,
    { schema: "butler.btcc-project-work-checkpoint.v1" }
  >,
  plans: Map<string, ExtractPlan>,
  results: ResultChild[],
): void {
  const checkpoint = child.checkpoint;
  const plan = plans.get(checkpoint.planRevisionId);
  const prefix = results
    .slice(child.resultWindow.fromSequence, child.resultWindow.toSequence)
    .map((result) => result.result.resultRef);
  if (
    !plan ||
    child.resultWindow.fromSequence !== 0 ||
    child.resultWindow.toSequence > results.length ||
    canonicalJson(prefix) !== canonicalJson(checkpoint.referencedResultRefs) ||
    canonicalJson(plan.actions.map((action) => action.actionKey)) !==
      canonicalJson(checkpoint.actionProgress.map((item) => item.actionKey))
  )
    invalid();
}

function validateCheckpointRole(
  child: CheckpointChild,
  children: ProjectWorkChild[],
): void {
  const identity = child.operationIdentity;
  if (identity.kind === "legacy_import") {
    if (child.checkpointIdentity !== child.checkpoint.checkpointRevisionId)
      invalid();
    return;
  }
  const siblings = children.filter(
    (candidate) =>
      candidate !== child &&
      canonicalJson(candidate.operationIdentity) === canonicalJson(identity),
  );
  if (child.checkpointIdentity === identity.id) {
    if (siblings.some(isPrimaryOperationChild)) invalid();
    return;
  }
  const suffix = child.checkpointIdentity.slice(identity.id.length + 1);
  const primary = siblings.filter(isPrimaryOperationChild);
  if (primary.length !== 1) invalid();
  const operation = primary[0]!;
  if (operation.schema === "butler.btcc-project-work-plan.v1") {
    if (
      (suffix !== "conception" && suffix !== "plan") ||
      child.checkpoint.stage !==
        (suffix === "conception" ? "conception" : "planning")
    )
      invalid();
    return;
  }
  if (operation.schema === "butler.btcc-project-work-review.v1") {
    const [entry, role] = suffix.split("-");
    if (
      !["review", "validation"].includes(entry ?? "") ||
      !["entry", "exit"].includes(role ?? "") ||
      (role === "entry" && child.checkpoint.stage !== entry)
    )
      invalid();
    return;
  }
  if (
    operation.schema !== "butler.btcc-project-work-disposition.v1" ||
    suffix !== "disposition" ||
    !operation.materialSnapshot.latestCheckpoint ||
    child.checkpoint.stage !== operation.materialSnapshot.latestCheckpoint.stage ||
    !sameProgress(
      child.checkpoint.actionProgress,
      operation.materialSnapshot.actionProgress,
    ) ||
    canonicalJson(child.checkpoint.referencedResultRefs) !==
      canonicalJson(
        operation.materialSnapshot.resultRefs.map(({ resultRef }) => resultRef),
      )
  ) {
    invalid();
  }
}

function sameProgress(
  left: Array<{ actionKey: string; status: string; note?: string | null }>,
  right: Array<{ actionKey: string; status: string; note?: string | null }>,
): boolean {
  const normalize = (items: typeof left) =>
    items.map((item) => ({ ...item, note: item.note ?? null }));
  return canonicalJson(normalize(left)) === canonicalJson(normalize(right));
}

function isPrimaryOperationChild(child: ProjectWorkChild): boolean {
  return [
    "butler.btcc-project-work-plan.v1",
    "butler.btcc-project-work-review.v1",
    "butler.btcc-project-work-disposition.v1",
  ].includes(child.schema);
}

function validateReview(
  child: ReviewChild,
  plans: Map<string, ExtractPlan>,
  reviews: Map<string, ReviewChild>,
  results: ResultChild[],
): void {
  const review = child.review;
  const prefix = results
    .slice(0, child.boundResultSequence)
    .map((result) => result.result.resultRef);
  if (
    child.boundResultSequence > results.length ||
    canonicalJson(prefix) !== canonicalJson(review.boundResultRefs) ||
    (review.boundPlanRevisionId && !plans.has(review.boundPlanRevisionId)) ||
    (review.subject === "plan" &&
      (!review.boundPlanRevisionId || review.boundResultRefs.length !== 0)) ||
    (review.subject === "result" && review.boundPlanRevisionId !== undefined) ||
    (review.subject !== "plan" && !review.boundActionProgress)
  ) invalid();
  if (!review.boundResultReviewRevisionId) {
    if (review.subject === "completion") invalid();
    return;
  }
  if (review.subject !== "completion") invalid();
  const bound = reviews.get(review.boundResultReviewRevisionId);
  if (
    !bound ||
    bound.review.subject !== "result" ||
    bound.review.verdict !== "accept" ||
    bound.review.revision >= review.revision ||
    bound.boundResultSequence !== child.boundResultSequence ||
    canonicalJson(bound.review.boundResultRefs) !==
      canonicalJson(review.boundResultRefs) ||
    !sameActionKeys(
      bound.review.boundActionProgress,
      review.boundActionProgress,
    )
  )
    invalid();
}

function validateDisposition(
  child: DispositionChild,
  manifest: ProjectWorkManifest,
  plans: Map<string, ExtractPlan>,
  reviews: Map<string, ReviewChild>,
  results: ResultChild[],
): void {
  const disposition = child.disposition;
  const snapshot = child.materialSnapshot;
  const resultPrefix = results.slice(0, disposition.resultSequence).map(
    ({ result }) => ({
      resultRef: result.resultRef,
      toolCallId: result.toolCallId,
      status: result.status,
      originTurnId: result.originTurnId,
    }),
  );
  if (
    snapshot.workId !== manifest.workId ||
    snapshot.materialFingerprint !== disposition.materialFingerprint ||
    snapshot.status !== disposition.disposition ||
    disposition.resultSequence > results.length ||
    canonicalJson(snapshot.resultRefs) !== canonicalJson(resultPrefix) ||
    (snapshot.currentPlan && !plans.has(snapshot.currentPlan.planRevisionId))
  )
    invalid();
  for (const review of snapshot.reviews) {
    if (!review) continue;
    const childReview = reviews.get(review.reviewRevisionId);
    if (
      !childReview ||
      childReview.review.revision !== review.revision ||
      childReview.review.verdict !== review.verdict
    )
      invalid();
  }
}

type ExtractPlan = Extract<
  ProjectWorkChild,
  { schema: "butler.btcc-project-work-plan.v1" }
>["plan"];
type ReviewChild = Extract<
  ProjectWorkChild,
  { schema: "butler.btcc-project-work-review.v1" }
>;
type ResultChild = Extract<
  ProjectWorkChild,
  { schema: "butler.btcc-project-work-result-reference.v1" }
>;
type DispositionChild = Extract<
  ProjectWorkChild,
  { schema: "butler.btcc-project-work-disposition.v1" }
>;
type CheckpointChild = Extract<
  ProjectWorkChild,
  { schema: "butler.btcc-project-work-checkpoint.v1" }
>;

function invalid(): never {
  throw new Error("project_work_managed_record_invalid");
}
