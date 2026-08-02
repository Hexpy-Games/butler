import type { Database } from "bun:sqlite";
import {
  type DurableWorkView,
  unresolvedWorkActionKeys,
} from "../../../btcc/work/index.ts";
import { hasUnresolvedEffectBlockers } from "./guided-work-effect-blockers.ts";
import { GuidedWorkViewReader } from "./guided-work-view-reader.ts";

export class GuidedWorkStatusWriter {
  constructor(
    private readonly db: Database,
    private readonly reader: GuidedWorkViewReader,
  ) {}

  tryComplete(
    workId: string,
    currentPlanRevisionId: string | null,
    now: string,
  ): boolean {
    if (hasUnresolvedEffectBlockers(this.db, workId)) {
      return false;
    }
    const view = this.reader.view(workId);
    const planReview = view.latestPlanReview;
    const resultReview = view.latestResultReview;
    const completionValidation = view.latestCompletionValidation;
    if (
      !currentPlanRevisionId ||
      planReview?.verdict !== "accept" ||
      planReview.boundPlanRevisionId !== currentPlanRevisionId ||
      resultReview?.verdict !== "accept" ||
      completionValidation?.verdict !== "accept" ||
      completionValidation.boundPlanRevisionId !== currentPlanRevisionId ||
      completionValidation.boundResultReviewRevisionId !==
        resultReview.reviewRevisionId ||
      !sameActionProgress(
        completionValidation.boundActionProgress,
        view.actionProgress,
      ) ||
      !sameRefs(
        completionValidation.boundResultRefs,
        view.resultRefs.map((result) => result.resultRef),
      )
    ) {
      return false;
    }
    if (unresolvedWorkActionKeys(view.actionProgress).length > 0) {
      return false;
    }
    const updated = this.db.query(`
      UPDATE btcc_guided_works SET status = 'completed', updated_at = ?
      WHERE work_id = ? AND status IN ('open', 'blocked')
    `).run(now, workId);
    return updated.changes === 1;
  }

  reopen(workId: string, now: string): void {
    const updated = this.db.query(`
      UPDATE btcc_guided_works SET status = 'open', updated_at = ?
      WHERE work_id = ? AND status = 'completed'
    `).run(now, workId);
    if (updated.changes !== 1) {
      throw new Error(`Durable Work could not be reopened: ${workId}`);
    }
  }
}

function sameRefs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function sameActionProgress(
  bound: DurableWorkView["actionProgress"] | undefined,
  current: DurableWorkView["actionProgress"],
): boolean {
  return bound?.length === current.length && bound.every((action, index) => {
    const candidate = current[index];
    return candidate?.actionKey === action.actionKey &&
      candidate.status === action.status && candidate.note === action.note;
  });
}
