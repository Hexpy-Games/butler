import type { DurableWorkView } from "./contracts.ts";
import { digest, stableJson } from "../identity/index.ts";

/**
 * Hash the material Work snapshot captured by a disposition.  This is a
 * durable freshness boundary for closeout reconciliation; it deliberately
 * excludes the disposition row itself and public/model projections.
 */
export function dispositionMaterialFingerprint(work: DurableWorkView): string {
  const actionProgress = (actions: readonly {
    actionKey: string;
    status: string;
    note?: string;
  }[]) => actions.map((action) => ({
    actionKey: action.actionKey,
    status: action.status,
    note: action.note ?? null,
  }));
  return digest(stableJson({
    workId: work.workId,
    status: work.status,
    currentPlan: work.currentPlan
      ? { planRevisionId: work.currentPlan.planRevisionId, revision: work.currentPlan.revision }
      : null,
    actionProgress: actionProgress(work.actionProgress),
    latestCheckpoint: work.latestCheckpoint
      ? {
          revision: work.latestCheckpoint.revision,
          planRevisionId: work.latestCheckpoint.planRevisionId,
          stage: work.latestCheckpoint.stage,
          actionProgress: actionProgress(work.latestCheckpoint.actionProgress),
          resultSequence: work.latestCheckpoint.referencedResultRefs.length,
          referencedResultRefs: work.latestCheckpoint.referencedResultRefs,
        }
      : null,
    reviews: [
      work.latestPlanReview,
      work.latestResultReview,
      work.latestCompletionValidation,
    ].map((review) => review
      ? {
          reviewRevisionId: review.reviewRevisionId,
          revision: review.revision,
          verdict: review.verdict,
          boundPlanRevisionId: review.boundPlanRevisionId ?? null,
          boundResultReviewRevisionId: review.boundResultReviewRevisionId ?? null,
          boundActionProgress: review.boundActionProgress
            ? actionProgress(review.boundActionProgress)
            : null,
          boundResultRefs: review.boundResultRefs,
        }
      : null),
    resultRefs: work.resultRefs.map((result) => ({
      resultRef: result.resultRef,
      toolCallId: result.toolCallId,
      status: result.status,
      originTurnId: result.originTurnId,
    })),
    effectWatermark: work.effectWatermark ?? null,
    effectBlockers: work.effectBlockers?.map((blocker) => ({
      blockerId: blocker.blockerId,
      sourceTurnId: blocker.sourceTurnId,
      capability: blocker.capability,
      target: blocker.target,
      detail: blocker.detail,
    })) ?? [],
  }));
}
