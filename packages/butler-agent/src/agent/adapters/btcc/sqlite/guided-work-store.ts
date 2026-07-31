import type { Database } from "bun:sqlite";
import type {
  AttachToolResultInput,
  DurableWorkContext,
  DurableWorkStore,
  DurableWorkView,
  LegacyOpenWorkImportResult,
  RecordWorkCheckpointInput,
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
import { GuidedWorkLegacyImporter } from "./guided-work-legacy-importer.ts";
import { GuidedWorkSessionWriter } from "./guided-work-session-writer.ts";
import { GuidedWorkStatusWriter } from "./guided-work-status-writer.ts";
import { GuidedWorkToolResultWriter } from "./guided-work-tool-result-writer.ts";
import { GuidedWorkViewReader } from "./guided-work-view-reader.ts";

export class SqliteGuidedWorkStore implements DurableWorkStore {
  private readonly reader: GuidedWorkViewReader;
  private readonly sessions: GuidedWorkSessionWriter;
  private readonly statuses: GuidedWorkStatusWriter;
  private readonly mutations: GuidedWorkMutationJournal;
  private readonly toolResults: GuidedWorkToolResultWriter;
  private readonly legacyImporter: GuidedWorkLegacyImporter;

  constructor(private readonly db: Database) {
    this.reader = new GuidedWorkViewReader(db);
    this.sessions = new GuidedWorkSessionWriter(db, this.reader);
    this.statuses = new GuidedWorkStatusWriter(db, this.reader);
    this.mutations = new GuidedWorkMutationJournal(db);
    this.toolResults = new GuidedWorkToolResultWriter(db);
    this.legacyImporter = new GuidedWorkLegacyImporter(db, this.reader);
  }

  async loadContext(scope: WorkTurnScope): Promise<DurableWorkContext | null> {
    return this.reader.loadContext(scope);
  }

  async importOpenLegacyWork(
    scope: WorkTurnScope,
  ): Promise<LegacyOpenWorkImportResult | null> {
    return this.db.transaction(() => this.legacyImporter.import(scope))();
  }

  async boundWorkForTurn(turnId: string): Promise<DurableWorkView | null> {
    return this.reader.boundView(turnId);
  }

  async bindOpenWork(
    scope: WorkTurnScope,
    expectedWorkId?: string,
  ): Promise<DurableWorkView | null> {
    return this.db.transaction(() => {
      const work = this.sessions.bindOpenHead(scope, expectedWorkId);
      return work ? this.reader.view(work.work_id) : null;
    })();
  }

  async replacePlan(input: ReplaceWorkPlanCommand): Promise<DurableWorkView> {
    const requestSha256 = guidedWorkMutationFingerprint("replace_plan", input);
    return this.db.transaction(() => {
      const replay = this.replay(input.mutationCallId, "replace_plan", requestSha256);
      if (replay) return replay;
      const work = this.sessions.selectForPlan(input);
      const revision = this.nextRevision(
        "btcc_guided_work_plan_revisions",
        work.work_id,
      );
      const planRevisionId = guidedWorkRecordId("plan", input.mutationCallId);
      const now = new Date().toISOString();
      this.db.query(`
        INSERT INTO btcc_guided_work_plan_revisions (
          plan_revision_id, work_id, revision, objective, actions_json,
          checks_json, origin_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        planRevisionId,
        work.work_id,
        revision,
        input.objective,
        stableJson(input.actions),
        stableJson(input.checks),
        input.turnId,
        now,
      );
      const updated = this.db.query(`
        UPDATE btcc_guided_works SET objective = ?, current_plan_revision_id = ?,
          status = 'open', updated_at = ? WHERE work_id = ?
      `).run(input.objective, planRevisionId, now, work.work_id);
      if (updated.changes !== 1) throw new Error("Durable Work Plan lost its Work");
      this.mutations.record({
        mutationCallId: input.mutationCallId,
        operation: "replace_plan",
        requestSha256,
        workId: work.work_id,
        recordId: planRevisionId,
      });
      return this.reader.view(work.work_id);
    })();
  }

  async recordCheckpoint(
    input: RecordWorkCheckpointInput,
  ): Promise<DurableWorkView> {
    const requestSha256 = guidedWorkMutationFingerprint("record_checkpoint", input);
    return this.db.transaction(() => {
      const replay = this.replay(
        input.mutationCallId,
        "record_checkpoint",
        requestSha256,
      );
      if (replay) return replay;
      const work = this.sessions.requireBoundHead(input);
      const revision = this.nextRevision(
        "btcc_guided_work_checkpoint_revisions",
        work.work_id,
      );
      const checkpointId = guidedWorkRecordId("checkpoint", input.mutationCallId);
      const resultSequence = this.latestResultSequence(work.work_id);
      const now = new Date().toISOString();
      this.db.query(`
        INSERT INTO btcc_guided_work_checkpoint_revisions (
          checkpoint_revision_id, work_id, revision, stage, public_summary,
          next_step, result_sequence, origin_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        checkpointId,
        work.work_id,
        revision,
        input.stage,
        input.publicSummary,
        input.nextStep,
        resultSequence,
        input.turnId,
        now,
      );
      this.touch(work.work_id, now);
      this.mutations.record({
        mutationCallId: input.mutationCallId,
        operation: "record_checkpoint",
        requestSha256,
        workId: work.work_id,
        recordId: checkpointId,
      });
      return this.reader.view(work.work_id);
    })();
  }

  async recordReview(input: RecordWorkReviewCommand): Promise<DurableWorkView> {
    const { completeWork, ...request } = input;
    const requestSha256 = guidedWorkMutationFingerprint("record_review", request);
    return this.db.transaction(() => {
      const replay = this.replay(input.mutationCallId, "record_review", requestSha256);
      if (replay) return replay;
      const work = this.sessions.requireBoundHead(input);
      if (input.subject === "plan" && !work.current_plan_revision_id) {
        throw new Error("Durable Work Plan Review requires a current Plan");
      }
      const revision = this.nextRevision(
        "btcc_guided_work_review_revisions",
        work.work_id,
      );
      const reviewId = guidedWorkRecordId("review", input.mutationCallId);
      const resultSequence = input.subject === "result"
        ? this.latestResultSequence(work.work_id)
        : null;
      const planRevisionId = input.subject === "plan"
        ? work.current_plan_revision_id
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
      if (completeWork) {
        this.statuses.complete(work.work_id, work.current_plan_revision_id, now);
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
    })();
  }

  async attachToolResult(input: AttachToolResultInput): Promise<DurableWorkView> {
    const requestSha256 = guidedWorkMutationFingerprint("attach_tool_result", input);
    return this.db.transaction(() => {
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
    })();
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

}
