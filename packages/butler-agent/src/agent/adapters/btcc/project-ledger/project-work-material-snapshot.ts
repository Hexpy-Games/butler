import type { DurableWorkView } from "../../../btcc/work/index.ts";
import {
  boundedArray,
  digestValue,
  exactKeys,
  invalid,
  nonnegative,
  object,
  positiveRevision,
  stringArray,
  textRequired,
} from "./project-work-json.ts";
import { canonicalJson } from "./project-work-json.ts";
import {
  captureMaterialPlan,
  validateMaterialPlan,
  type ProjectWorkMaterialPlan,
} from "./project-work-material-plan.ts";

export type ProjectWorkMaterialSnapshot = {
  materialFingerprint: string;
  workId: string;
  status: DurableWorkView["status"];
  currentPlan: ProjectWorkMaterialPlan | null;
  actionProgress: Array<{
    actionKey: string;
    status: string;
    note: string | null;
  }>;
  latestCheckpoint: {
    revision: number;
    planRevisionId: string;
    stage: string;
    actionProgress: Array<{
      actionKey: string;
      status: string;
      note: string | null;
    }>;
    resultSequence: number;
    referencedResultRefs: string[];
  } | null;
  reviews: Array<{
    reviewRevisionId: string;
    revision: number;
    verdict: string;
    boundPlanRevisionId: string | null;
    boundResultReviewRevisionId: string | null;
    boundActionProgress: Array<{
      actionKey: string;
      status: string;
      note: string | null;
    }> | null;
    boundResultRefs: string[];
  } | null>;
  resultRefs: Array<{
    resultRef: string;
    toolCallId: string;
    status: string;
    originTurnId: string;
  }>;
  effectWatermark: string | null;
  effectBlockers: Array<{
    blockerId: string;
    sourceTurnId: string;
    capabilitySha256: string;
    targetSha256: string;
    detailSha256: string;
  }>;
};

export function captureMaterialSnapshot(
  work: DurableWorkView,
  effectProof: Pick<
    ProjectWorkMaterialSnapshot,
    "effectWatermark" | "effectBlockers"
  >,
  materialFingerprint: string,
): ProjectWorkMaterialSnapshot {
  const progress = (items: DurableWorkView["actionProgress"]) =>
    items.map((item) => ({
      actionKey: item.actionKey,
      status: item.status,
      note: item.note ?? null,
    }));
  return {
    materialFingerprint,
    workId: work.workId,
    status: work.status,
    currentPlan: work.currentPlan
      ? captureMaterialPlan(work.currentPlan)
      : null,
    actionProgress: progress(work.actionProgress),
    latestCheckpoint: work.latestCheckpoint
      ? {
          revision: work.latestCheckpoint.revision,
          planRevisionId: work.latestCheckpoint.planRevisionId,
          stage: work.latestCheckpoint.stage,
          actionProgress: progress(work.latestCheckpoint.actionProgress),
          resultSequence: work.latestCheckpoint.referencedResultRefs.length,
          referencedResultRefs: work.latestCheckpoint.referencedResultRefs,
        }
      : null,
    reviews: [
      work.latestPlanReview,
      work.latestResultReview,
      work.latestCompletionValidation,
    ].map((review) =>
      review
        ? {
            reviewRevisionId: review.reviewRevisionId,
            revision: review.revision,
            verdict: review.verdict,
            boundPlanRevisionId: review.boundPlanRevisionId ?? null,
            boundResultReviewRevisionId:
              review.boundResultReviewRevisionId ?? null,
            boundActionProgress: review.boundActionProgress
              ? progress(review.boundActionProgress)
              : null,
            boundResultRefs: review.boundResultRefs,
          }
        : null,
    ),
    resultRefs: work.resultRefs.map((result) => ({
      resultRef: result.resultRef,
      toolCallId: result.toolCallId,
      status: result.status,
      originTurnId: result.originTurnId,
    })),
    effectWatermark: effectProof.effectWatermark,
    effectBlockers: effectProof.effectBlockers,
  };
}

export function validateMaterialSnapshot(
  value: unknown,
): asserts value is ProjectWorkMaterialSnapshot {
  const item = object(value);
  exactKeys(item, [
    "materialFingerprint",
    "workId",
    "status",
    "currentPlan",
    "actionProgress",
    "latestCheckpoint",
    "reviews",
    "resultRefs",
    "effectWatermark",
    "effectBlockers",
  ]);
  digestValue(item.materialFingerprint);
  textRequired(item.workId);
  if (
    !["open", "blocked", "completed", "abandoned"].includes(String(item.status))
  )
    invalid();
  if (item.effectWatermark !== null) textRequired(item.effectWatermark);
  const blockerIds = new Set<string>();
  boundedArray(item.effectBlockers).forEach((value) => {
    const blocker = object(value);
    exactKeys(blocker, [
      "blockerId",
      "sourceTurnId",
      "capabilitySha256",
      "targetSha256",
      "detailSha256",
    ]);
    textRequired(blocker.blockerId);
    if (blockerIds.has(String(blocker.blockerId))) invalid();
    blockerIds.add(String(blocker.blockerId));
    textRequired(blocker.sourceTurnId);
    digestValue(blocker.capabilitySha256);
    digestValue(blocker.targetSha256);
    digestValue(blocker.detailSha256);
  });
  if (item.currentPlan !== null) {
    validateMaterialPlan(item.currentPlan);
  }
  boundedArray(item.actionProgress).forEach(validateProgress);
  if (item.latestCheckpoint !== null) validateCheckpoint(item.latestCheckpoint);
  const reviews = boundedArray(item.reviews);
  if (reviews.length !== 3) invalid();
  reviews.forEach((review) => {
    if (review !== null) validateReview(review);
  });
  boundedArray(item.resultRefs).forEach((result) => {
    const ref = object(result);
    exactKeys(ref, ["resultRef", "toolCallId", "status", "originTurnId"]);
    textRequired(ref.resultRef);
    textRequired(ref.toolCallId);
    textRequired(ref.originTurnId);
    if (ref.status !== "completed") invalid();
  });
}

export function assertMaterialSnapshotForView(
  snapshot: ProjectWorkMaterialSnapshot,
  view: DurableWorkView,
  materialFingerprint: string,
): void {
  validateMaterialSnapshot(snapshot);
  if (snapshot.materialFingerprint !== materialFingerprint) invalid();
  if (!materialSnapshotMatchesView(snapshot, view)) invalid();
}

export function materialSnapshotMatchesView(
  snapshot: ProjectWorkMaterialSnapshot,
  view: DurableWorkView,
): boolean {
  validateMaterialSnapshot(snapshot);
  const expected = captureMaterialSnapshot(
    view,
    {
      effectWatermark: snapshot.effectWatermark,
      effectBlockers: snapshot.effectBlockers,
    },
    snapshot.materialFingerprint,
  );
  return canonicalJson(expected) === canonicalJson(snapshot);
}

function validateCheckpoint(value: unknown): void {
  const item = object(value);
  exactKeys(item, [
    "revision",
    "planRevisionId",
    "stage",
    "actionProgress",
    "resultSequence",
    "referencedResultRefs",
  ]);
  positiveRevision(item.revision);
  textRequired(item.planRevisionId);
  textRequired(item.stage);
  boundedArray(item.actionProgress).forEach(validateProgress);
  nonnegative(item.resultSequence);
  stringArray(item.referencedResultRefs);
  if (item.resultSequence !== (item.referencedResultRefs as unknown[]).length)
    invalid();
}
function validateReview(value: unknown): void {
  const item = object(value);
  exactKeys(item, [
    "reviewRevisionId",
    "revision",
    "verdict",
    "boundPlanRevisionId",
    "boundResultReviewRevisionId",
    "boundActionProgress",
    "boundResultRefs",
  ]);
  textRequired(item.reviewRevisionId);
  positiveRevision(item.revision);
  textRequired(item.verdict);
  stringArray(item.boundResultRefs);
  if (item.boundPlanRevisionId !== null) textRequired(item.boundPlanRevisionId);
  if (item.boundResultReviewRevisionId !== null)
    textRequired(item.boundResultReviewRevisionId);
  if (item.boundActionProgress !== null)
    boundedArray(item.boundActionProgress).forEach(validateProgress);
}
function validateProgress(value: unknown): void {
  const item = object(value);
  exactKeys(item, ["actionKey", "status", "note"]);
  textRequired(item.actionKey);
  textRequired(item.status);
  if (item.note !== null && typeof item.note !== "string") invalid();
}
