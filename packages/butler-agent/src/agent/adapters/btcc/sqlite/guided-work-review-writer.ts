import type { Database } from "bun:sqlite";
import type {
  DurableWorkView,
  RecordWorkReviewCommand,
} from "../../../btcc/work/index.ts";
import { preserveBlockedStatus } from "./guided-work-effect-blockers.ts";
import { GuidedWorkMutationJournal } from "./guided-work-mutation-journal.ts";
import { GuidedWorkProgressWriter } from "./guided-work-progress-writer.ts";
import { guidedWorkStatusForProgress } from "./guided-work-progress-status.ts";
import { guidedWorkRecordId } from "./guided-work-record-id.ts";
import { GuidedWorkSessionWriter } from "./guided-work-session-writer.ts";
import { GuidedWorkViewReader } from "./guided-work-view-reader.ts";
import { stableJson } from "./identity.ts";

export class GuidedWorkReviewWriter {
  constructor(
    private readonly db: Database,
    private readonly reader: GuidedWorkViewReader,
    private readonly sessions: GuidedWorkSessionWriter,
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
      this.assertCompletionResultReview(work.work_id, input);

      const now = new Date().toISOString();
      if (
        input.subject === "completion" ||
        input.currentStage !== input.entryStage ||
        input.progressChanged
      ) {
        this.progress.insert({
          workId: work.work_id,
          planRevisionId: input.expectedPlanRevisionId,
          stage: input.entryStage,
          actionProgress: input.actionProgress,
          publicSummary: input.summary,
          nextStep: input.corrections[0] ?? "",
          resultSequence: input.expectedResultSequence,
          originTurnId: input.turnId,
          identity: `${input.mutationCallId}\0${input.entryStage}-entry`,
          now,
        });
      }

      const reviewId = guidedWorkRecordId("review", input.mutationCallId);
      const resultSequence = input.subject !== "plan"
        ? input.expectedResultSequence
        : null;
      const planRevisionId = input.subject !== "result"
        ? input.expectedPlanRevisionId
        : null;
      const resultReviewRevisionId = input.subject === "completion"
        ? input.expectedResultReviewRevisionId ?? null
        : null;
      const actionStates = input.subject === "completion"
        ? stableJson(input.actionProgress)
        : null;
      this.db.query(`
        INSERT INTO btcc_guided_work_review_revisions (
          review_revision_id, work_id, revision, subject, verdict, summary,
          corrections_json, bound_plan_revision_id, bound_result_sequence,
          bound_result_review_revision_id, bound_action_states_json,
          origin_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        resultReviewRevisionId,
        actionStates,
        input.turnId,
        now,
      );

      if (input.nextStage && input.nextStage !== input.entryStage) {
        this.progress.insert({
          workId: work.work_id,
          planRevisionId: input.expectedPlanRevisionId,
          stage: input.nextStage,
          actionProgress: input.actionProgress,
          publicSummary: input.summary,
          nextStep: input.corrections[0] ?? "",
          resultSequence: input.expectedResultSequence,
          originTurnId: input.turnId,
          identity: `${input.mutationCallId}\0${input.entryStage}-exit`,
          now,
        });
      }

      this.db.query(`
        UPDATE btcc_guided_works SET status = ?, updated_at = ? WHERE work_id = ?
      `).run(guidedWorkStatusForProgress(input.actionProgress), now, work.work_id);
      preserveBlockedStatus(this.db, work.work_id);
      // Review/Validation is optional quality evidence.  It must not be a
      // second closeout authority: Work status changes to `completed` only
      // inside the atomic record_work_disposition transaction.
      this.touch(work.work_id, now);

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

  private assertCompletionResultReview(
    workId: string,
    input: RecordWorkReviewCommand,
  ): void {
    if (input.subject !== "completion") return;
    if (!input.expectedResultReviewRevisionId) {
      throw new Error("Durable Work completion requires an accepted result Review");
    }
    const review = this.db.query<{
      review_revision_id: string;
      verdict: string;
      bound_result_sequence: number | null;
    }, [string]>(`
      SELECT review_revision_id, verdict, bound_result_sequence
      FROM btcc_guided_work_review_revisions
      WHERE work_id = ? AND subject = 'result'
      ORDER BY revision DESC LIMIT 1
    `).get(workId);
    if (
      review?.review_revision_id !== input.expectedResultReviewRevisionId ||
      review.verdict !== "accept" ||
      review.bound_result_sequence !== input.expectedResultSequence
    ) {
      throw new Error("Durable Work result Review changed before completion Validation");
    }
  }

  private touch(workId: string, now: string): void {
    this.db.query("UPDATE btcc_guided_works SET updated_at = ? WHERE work_id = ?")
      .run(now, workId);
  }
}
