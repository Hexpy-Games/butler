import type { Database } from "bun:sqlite";
import type {
  DurableWorkView,
  RecordWorkReviewCommand,
} from "../../../btcc/durable-work/index.ts";
import { preserveBlockedStatus } from "./guided-work-effect-blockers.ts";
import { GuidedWorkMutationJournal } from "./guided-work-mutation-journal.ts";
import { GuidedWorkProgressWriter } from "./guided-work-progress-writer.ts";
import { guidedWorkRecordId } from "./guided-work-record-id.ts";
import { GuidedWorkSessionWriter } from "./guided-work-session-writer.ts";
import { GuidedWorkStatusWriter } from "./guided-work-status-writer.ts";
import { GuidedWorkViewReader } from "./guided-work-view-reader.ts";
import { stableJson } from "./identity.ts";

export class GuidedWorkReviewWriter {
  constructor(
    private readonly db: Database,
    private readonly reader: GuidedWorkViewReader,
    private readonly sessions: GuidedWorkSessionWriter,
    private readonly statuses: GuidedWorkStatusWriter,
    private readonly mutations: GuidedWorkMutationJournal,
    private readonly progress: GuidedWorkProgressWriter,
  ) {}

  record(input: RecordWorkReviewCommand): DurableWorkView {
    return this.db.transaction(() => {
      const replayWorkId = this.mutations.replayWorkId(
        input.mutationCallId,
        "record_review",
        input.requestSha256,
      );
      if (replayWorkId) return this.reader.view(replayWorkId);

      const work = this.sessions.requireBoundHead(input);
      if (input.subject === "plan" && !work.current_plan_revision_id) {
        throw new Error("Durable Work Plan Review requires a current Plan");
      }
      if (work.current_plan_revision_id !== input.expectedPlanRevisionId) {
        throw new Error("Durable Work Plan changed before its Review");
      }
      this.progress.assertRevision(work.work_id, input.expectedProgressRevision);
      if (this.latestResultSequence(work.work_id) !== input.expectedResultSequence) {
        throw new Error("Durable Work results changed before its Review");
      }

      const now = new Date().toISOString();
      if (input.currentStage !== "review" || input.progressChanged) {
        this.progress.insert({
          workId: work.work_id,
          planRevisionId: input.expectedPlanRevisionId,
          stage: "review",
          actionProgress: input.actionProgress,
          publicSummary: input.summary,
          nextStep: input.corrections[0] ?? "",
          resultSequence: input.expectedResultSequence,
          originTurnId: input.turnId,
          identity: `${input.mutationCallId}\0review-entry`,
          now,
        });
      }

      const reviewId = guidedWorkRecordId("review", input.mutationCallId);
      const resultSequence = input.subject === "result"
        ? input.expectedResultSequence
        : null;
      const planRevisionId = input.subject === "plan"
        ? input.expectedPlanRevisionId
        : null;
      this.db.query(`
        INSERT INTO btcc_guided_work_review_revisions (
          review_revision_id, work_id, revision, subject, verdict, summary,
          corrections_json, bound_plan_revision_id, bound_result_sequence,
          origin_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reviewId,
        work.work_id,
        this.nextRevision(work.work_id),
        input.subject,
        input.verdict,
        input.summary,
        stableJson(input.corrections),
        planRevisionId,
        resultSequence,
        input.turnId,
        now,
      );

      if (input.nextStage && input.nextStage !== "review") {
        this.progress.insert({
          workId: work.work_id,
          planRevisionId: input.expectedPlanRevisionId,
          stage: input.nextStage,
          actionProgress: input.actionProgress,
          publicSummary: input.summary,
          nextStep: input.corrections[0] ?? "",
          resultSequence: input.expectedResultSequence,
          originTurnId: input.turnId,
          identity: `${input.mutationCallId}\0review-exit`,
          now,
        });
      }

      this.db.query(`
        UPDATE btcc_guided_works SET status = ?, updated_at = ? WHERE work_id = ?
      `).run(progressWorkStatus(input), now, work.work_id);
      preserveBlockedStatus(this.db, work.work_id);
      if (input.completeWork) {
        if (
          !this.statuses.tryComplete(
            work.work_id,
            input.expectedPlanRevisionId,
            now,
          )
        ) {
          this.touch(work.work_id, now);
        }
      } else {
        this.touch(work.work_id, now);
      }

      this.mutations.record({
        mutationCallId: input.mutationCallId,
        operation: "record_review",
        requestSha256: input.requestSha256,
        workId: work.work_id,
        recordId: reviewId,
      });
      return this.reader.view(work.work_id);
    }).immediate();
  }

  private nextRevision(workId: string): number {
    return this.db.query<{ revision: number }, [string]>(`
      SELECT COALESCE(MAX(revision), 0) + 1 AS revision
      FROM btcc_guided_work_review_revisions WHERE work_id = ?
    `).get(workId)?.revision ?? 1;
  }

  private latestResultSequence(workId: string): number {
    return this.db.query<{ sequence: number }, [string]>(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM btcc_guided_work_results WHERE work_id = ?
    `).get(workId)?.sequence ?? 0;
  }

  private touch(workId: string, now: string): void {
    this.db.query("UPDATE btcc_guided_works SET updated_at = ? WHERE work_id = ?")
      .run(now, workId);
  }
}

function progressWorkStatus(
  input: Pick<RecordWorkReviewCommand, "actionProgress">,
): "open" | "blocked" {
  return input.actionProgress.some((action) => action.status === "blocked")
    ? "blocked"
    : "open";
}
