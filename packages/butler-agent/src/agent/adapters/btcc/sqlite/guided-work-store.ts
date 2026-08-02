import type { Database } from "bun:sqlite";
import type {
  AttachToolResultInput,
  DurableWorkContext,
  DurableWorkStore,
  DurableWorkView,
  LegacyOpenWorkImportResult,
  LegacyProjectWorkSource,
  RecordWorkCheckpointCommand,
  RecordWorkReviewCommand,
  ReplaceWorkPlanCommand,
  WorkTurnScope,
} from "../../../btcc/durable-work/index.ts";
import { stableJson } from "./identity.ts";
import {
  GuidedWorkMutationJournal,
  guidedWorkMutationFingerprint,
  type GuidedWorkMutationOperation,
} from "./guided-work-mutation-journal.ts";
import { guidedWorkRecordId } from "./guided-work-record-id.ts";
import { GuidedWorkProgressWriter } from "./guided-work-progress-writer.ts";
import { preserveBlockedStatus } from "./guided-work-effect-blockers.ts";
import { GuidedWorkLegacyImporter } from "./guided-work-legacy-importer.ts";
import { GuidedWorkLegacyProjectImporter } from
  "./guided-work-legacy-project-importer.ts";
import { GuidedWorkSessionWriter } from "./guided-work-session-writer.ts";
import { GuidedWorkStatusWriter } from "./guided-work-status-writer.ts";
import { GuidedWorkToolResultWriter } from "./guided-work-tool-result-writer.ts";
import { GuidedWorkViewReader } from "./guided-work-view-reader.ts";

export class SqliteGuidedWorkStore implements DurableWorkStore {
  private readonly reader: GuidedWorkViewReader;
  private readonly sessions: GuidedWorkSessionWriter;
  private readonly statuses: GuidedWorkStatusWriter;
  private readonly mutations: GuidedWorkMutationJournal;
  private readonly progress: GuidedWorkProgressWriter;
  private readonly toolResults: GuidedWorkToolResultWriter;
  private readonly legacyImporter: GuidedWorkLegacyImporter;
  private readonly legacyProjectImporter: GuidedWorkLegacyProjectImporter;

  constructor(
    private readonly db: Database,
    private readonly legacyProjectWork?: LegacyProjectWorkSource,
  ) {
    this.reader = new GuidedWorkViewReader(db);
    this.sessions = new GuidedWorkSessionWriter(db, this.reader);
    this.statuses = new GuidedWorkStatusWriter(db, this.reader);
    this.mutations = new GuidedWorkMutationJournal(db);
    this.progress = new GuidedWorkProgressWriter(db);
    this.toolResults = new GuidedWorkToolResultWriter(db);
    this.legacyImporter = new GuidedWorkLegacyImporter(db, this.reader);
    this.legacyProjectImporter = new GuidedWorkLegacyProjectImporter(
      db,
      this.reader,
    );
  }

  async loadContext(scope: WorkTurnScope): Promise<DurableWorkContext | null> {
    return this.reader.loadContext(scope);
  }

  async importOpenLegacyWork(
    scope: WorkTurnScope,
  ): Promise<LegacyOpenWorkImportResult | null> {
    if (scope.projectRef) {
      if (!this.legacyProjectWork) return null;
      const programIds = this.legacyProjectImporter.locateProgramIds(scope);
      if (programIds.length === 0) return null;
      const replay = this.writeTransaction(() =>
        this.legacyProjectImporter.replay(scope, programIds));
      if (replay) return replay;
      const snapshot = await this.legacyProjectWork.loadOpenWork({
        projectRef: scope.projectRef,
        programIds,
      });
      if (!snapshot) return null;
      return this.writeTransaction(() =>
        this.legacyProjectImporter.import(scope, snapshot));
    }
    return this.writeTransaction(() => this.legacyImporter.import(scope));
  }

  async boundWorkForTurn(turnId: string): Promise<DurableWorkView | null> {
    return this.reader.boundView(turnId);
  }

  async bindOpenWork(
    scope: WorkTurnScope,
    expectedWorkId?: string,
  ): Promise<DurableWorkView | null> {
    return this.writeTransaction(() => {
      const work = this.sessions.bindOpenHead(scope, expectedWorkId);
      return work ? this.reader.view(work.work_id) : null;
    });
  }

  async replacePlan(input: ReplaceWorkPlanCommand): Promise<DurableWorkView> {
    const requestSha256 = input.requestSha256;
    return this.writeTransaction(() => {
      const replay = this.replay(input.mutationCallId, "replace_plan", requestSha256);
      if (replay) return replay;
      const work = this.sessions.selectForPlan(input);
      if (input.expectedWorkId && work.work_id !== input.expectedWorkId) {
        throw new Error("Durable Work changed before its Plan update");
      }
      if (input.expectedProgressRevision !== undefined) {
        this.progress.assertRevision(work.work_id, input.expectedProgressRevision);
      }
      const revision = this.nextRevision(
        "btcc_guided_work_plan_revisions",
        work.work_id,
      );
      const planRevisionId = guidedWorkRecordId("plan", input.mutationCallId);
      const now = new Date().toISOString();
      this.db.query(`
        INSERT INTO btcc_guided_work_plan_revisions (
          plan_revision_id, work_id, revision, objective, governing_refs_json,
          actions_json, checks_json, origin_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        planRevisionId,
        work.work_id,
        revision,
        input.objective,
        stableJson(input.governingRefs),
        stableJson(input.actions),
        stableJson(input.checks),
        input.turnId,
        now,
      );
      this.progress.insert({
        workId: work.work_id,
        planRevisionId,
        stage: "planning",
        actionProgress: input.actionProgress,
        publicSummary: input.objective,
        nextStep: input.actions[0]?.description ?? "",
        resultSequence: this.latestResultSequence(work.work_id),
        originTurnId: input.turnId,
        identity: `${input.mutationCallId}\0plan`,
        now,
      });
      const updated = this.db.query(`
        UPDATE btcc_guided_works SET current_plan_revision_id = ?,
          status = ?, updated_at = ? WHERE work_id = ?
      `).run(
        planRevisionId,
        progressWorkStatus(input.actionProgress),
        now,
        work.work_id,
      );
      if (updated.changes !== 1) throw new Error("Durable Work Plan lost its Work");
      preserveBlockedStatus(this.db, work.work_id);
      this.mutations.record({
        mutationCallId: input.mutationCallId,
        operation: "replace_plan",
        requestSha256,
        workId: work.work_id,
        recordId: planRevisionId,
      });
      return this.reader.view(work.work_id);
    });
  }

  async recordCheckpoint(
    input: RecordWorkCheckpointCommand,
  ): Promise<DurableWorkView> {
    const requestSha256 = input.requestSha256;
    return this.writeTransaction(() => {
      const replay = this.replay(
        input.mutationCallId,
        "record_checkpoint",
        requestSha256,
      );
      if (replay) return replay;
      const work = this.sessions.requireBoundHead(input);
      if (work.current_plan_revision_id !== input.expectedPlanRevisionId) {
        throw new Error("Durable Work Plan changed before its progress update");
      }
      this.progress.assertRevision(work.work_id, input.expectedProgressRevision);
      const now = new Date().toISOString();
      const checkpointId = this.progress.insert({
        workId: work.work_id,
        planRevisionId: input.expectedPlanRevisionId,
        stage: input.stage,
        actionProgress: input.actionProgress,
        publicSummary: input.publicSummary,
        nextStep: input.nextStep,
        resultSequence: this.latestResultSequence(work.work_id),
        originTurnId: input.turnId,
        identity: input.mutationCallId,
        now,
      });
      this.db.query(`
        UPDATE btcc_guided_works SET status = ?, updated_at = ? WHERE work_id = ?
      `).run(progressWorkStatus(input.actionProgress), now, work.work_id);
      preserveBlockedStatus(this.db, work.work_id);
      this.mutations.record({
        mutationCallId: input.mutationCallId,
        operation: "record_checkpoint",
        requestSha256,
        workId: work.work_id,
        recordId: checkpointId,
      });
      return this.reader.view(work.work_id);
    });
  }

  async recordReview(input: RecordWorkReviewCommand): Promise<DurableWorkView> {
    const requestSha256 = input.requestSha256;
    return this.writeTransaction(() => {
      const replay = this.replay(input.mutationCallId, "record_review", requestSha256);
      if (replay) return replay;
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
      const revision = this.nextRevision(
        "btcc_guided_work_review_revisions",
        work.work_id,
      );
      const reviewId = guidedWorkRecordId("review", input.mutationCallId);
      const resultSequence = input.subject === "result"
        ? input.expectedResultSequence
        : null;
      const planRevisionId = input.subject === "plan"
        ? input.expectedPlanRevisionId
        : null;
      const now = new Date().toISOString();
      this.db.query(`
        INSERT INTO btcc_guided_work_review_revisions (
          review_revision_id, work_id, revision, subject, verdict, summary,
          corrections_json, bound_plan_revision_id, bound_result_sequence,
          origin_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reviewId,
        work.work_id,
        revision,
        input.subject,
        input.verdict,
        input.summary,
        stableJson(input.corrections),
        planRevisionId,
        resultSequence,
        input.turnId,
        now,
      );
      if (input.completeWork) {
        if (!this.statuses.tryComplete(work.work_id, input.expectedPlanRevisionId, now)) {
          this.touch(work.work_id, now);
        }
      } else {
        this.touch(work.work_id, now);
      }
      this.mutations.record({
        mutationCallId: input.mutationCallId,
        operation: "record_review",
        requestSha256,
        workId: work.work_id,
        recordId: reviewId,
      });
      return this.reader.view(work.work_id);
    });
  }

  async attachToolResult(input: AttachToolResultInput): Promise<DurableWorkView> {
    const requestSha256 = guidedWorkMutationFingerprint("attach_tool_result", input);
    return this.writeTransaction(() => {
      const replay = this.replay(
        input.mutationCallId,
        "attach_tool_result",
        requestSha256,
      );
      if (replay) return replay;
      const work = this.sessions.requireBoundForResult(input);
      const resultRef = this.toolResults.attach(work.work_id, input);
      const now = new Date().toISOString();
      if (work.status === "completed") {
        this.statuses.reopen(work.work_id, now);
      } else {
        this.touch(work.work_id, now);
      }
      this.mutations.record({
        mutationCallId: input.mutationCallId,
        operation: "attach_tool_result",
        requestSha256,
        workId: work.work_id,
        recordId: resultRef,
      });
      return this.reader.view(work.work_id);
    });
  }

  private replay(
    mutationCallId: string,
    operation: GuidedWorkMutationOperation,
    requestSha256: string,
  ): DurableWorkView | null {
    const workId = this.mutations.replayWorkId(
      mutationCallId,
      operation,
      requestSha256,
    );
    return workId ? this.reader.view(workId) : null;
  }

  private nextRevision(
    table:
      | "btcc_guided_work_plan_revisions"
      | "btcc_guided_work_checkpoint_revisions"
      | "btcc_guided_work_review_revisions",
    workId: string,
  ): number {
    return this.db.query<{ revision: number }, [string]>(`
      SELECT COALESCE(MAX(revision), 0) + 1 AS revision
      FROM ${table} WHERE work_id = ?
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

  private writeTransaction<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }

}

function progressWorkStatus(
  progress: ReplaceWorkPlanCommand["actionProgress"],
): "open" | "blocked" {
  return progress.some((action) => action.status === "blocked") ? "blocked" : "open";
}
