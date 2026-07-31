import type { Database } from "bun:sqlite";
import { hasUnresolvedEffectBlockers } from "./guided-work-effect-blockers.ts";
import { GuidedWorkViewReader } from "./guided-work-view-reader.ts";

export class GuidedWorkStatusWriter {
  constructor(
    private readonly db: Database,
    private readonly reader: GuidedWorkViewReader,
  ) {}

  complete(
    workId: string,
    currentPlanRevisionId: string | null,
    now: string,
  ): void {
    if (hasUnresolvedEffectBlockers(this.db, workId)) {
      throw new Error(
        "Durable Work cannot complete while a prior effect requires reconciliation",
      );
    }
    const review = this.reader.view(workId).latestPlanReview;
    if (
      !currentPlanRevisionId ||
      review?.verdict !== "accept" ||
      review.boundPlanRevisionId !== currentPlanRevisionId
    ) {
      throw new Error(
        "Durable Work completion requires an accepted Review of the current Plan",
      );
    }
    const updated = this.db.query(`
      UPDATE btcc_guided_works SET status = 'completed', updated_at = ?
      WHERE work_id = ? AND status IN ('open', 'blocked')
    `).run(now, workId);
    if (updated.changes !== 1) {
      throw new Error(`Durable Work could not be completed: ${workId}`);
    }
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
