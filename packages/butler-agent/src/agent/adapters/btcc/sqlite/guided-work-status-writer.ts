import type { Database } from "bun:sqlite";
import { unresolvedWorkActionKeys } from "../../../btcc/durable-work/index.ts";
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
    const review = view.latestPlanReview;
    if (
      !currentPlanRevisionId ||
      review?.verdict !== "accept" ||
      review.boundPlanRevisionId !== currentPlanRevisionId
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
