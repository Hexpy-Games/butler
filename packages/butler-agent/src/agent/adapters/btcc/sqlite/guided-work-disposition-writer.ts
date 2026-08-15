import type { Database } from "bun:sqlite";
import type {
  DurableWorkActionProgress,
  DurableWorkDispositionActionUpdate,
  DurableWorkView,
  RecordCloseoutMissingInput,
  RecordWorkDispositionCommand,
} from "../../../btcc/work/index.ts";
import {
  applyWorkActionUpdates,
  dispositionMaterialFingerprint,
} from "../../../btcc/work/index.ts";
import { digest, stableJson } from "./identity.ts";
import { guidedWorkRecordId } from "./guided-work-record-id.ts";
import { GuidedWorkProgressWriter } from "./guided-work-progress-writer.ts";
import { GuidedWorkSessionWriter } from "./guided-work-session-writer.ts";
import { GuidedWorkToolResultWriter } from "./guided-work-tool-result-writer.ts";
import { GuidedWorkViewReader } from "./guided-work-view-reader.ts";
import { unresolvedEffectBlockersForWork } from "./guided-work-effect-blockers.ts";
import {
  normalizeDispositionOptional,
  normalizeDispositionStringList,
  resolveDispositionEvidence,
} from "./guided-work-disposition-evidence.ts";

const CONTROL_TOOL_NAMES = [
  "start_work",
  "continue_work",
  "replace_work_plan",
  "record_work_checkpoint",
  "record_work_review",
  "record_work_disposition",
] as const;

const ACTIVE_EFFECT_STATUSES = [
  "pending",
  "prepared",
  "dispatching",
  "uncertain",
] as const;

export class GuidedWorkDispositionWriter {
  constructor(
    private readonly db: Database,
    private readonly reader: GuidedWorkViewReader,
    private readonly sessions: GuidedWorkSessionWriter,
    private readonly progress: GuidedWorkProgressWriter,
    private readonly toolResults: GuidedWorkToolResultWriter,
  ) {}

  record(input: RecordWorkDispositionCommand): DurableWorkView {
    return this.db.transaction(() => {
      const replay = this.replay(input);
      if (replay) return replay;

      const work = this.sessions.requireBoundForDisposition(input);
      if (work.work_id !== input.workId) {
        throw new Error("Durable Work disposition target is not bound to this Turn");
      }

      this.attachCurrentTurnResults(work.work_id, input);
      const current = this.reader.view(work.work_id);
      const actionProgress = this.actionProgress(current, input.actionUpdates ?? []);
      const remainingActions = normalizeDispositionStringList(input.remainingActions ?? []);
      const nextCondition = normalizeDispositionOptional(input.nextCondition);
      const evidenceRefs = normalizeDispositionStringList(input.evidenceRefs ?? []);
      const followups = normalizeDispositionStringList(input.followups ?? []);
      const evidenceSnapshot = resolveDispositionEvidence(
        this.db,
        work.work_id,
        input.turnId,
        evidenceRefs,
      );

      this.validateDisposition({
        disposition: input.disposition,
        actionProgress,
        remainingActions,
        nextCondition,
        workId: work.work_id,
      });

      const now = new Date().toISOString();
      const revision = this.nextRevision(work.work_id);
      const resultSequence = this.latestResultSequence(work.work_id);
      const dispositionRevisionId = guidedWorkRecordId(
        "disposition",
        input.mutationCallId,
      );
      this.db.query(`
        INSERT INTO btcc_guided_work_disposition_revisions (
          disposition_revision_id, work_id, revision, result_sequence, disposition, summary,
          material_fingerprint,
          action_updates_json, remaining_actions_json, next_condition,
          evidence_refs_json, evidence_snapshot_json, followups_json,
          origin_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        dispositionRevisionId,
        work.work_id,
        revision,
        resultSequence,
        input.disposition,
        input.summary.trim(),
        "",
        stableJson(input.actionUpdates ?? []),
        stableJson(remainingActions),
        nextCondition ?? null,
        stableJson(evidenceRefs),
        stableJson(evidenceSnapshot),
        stableJson(followups),
        input.turnId,
        now,
      );

      if (current.currentPlan) {
        this.progress.insert({
          workId: work.work_id,
          planRevisionId: current.currentPlan.planRevisionId,
          stage: current.currentStage ?? "planning",
          actionProgress,
          publicSummary: input.summary.trim(),
          nextStep: remainingActions[0] ?? nextCondition ?? "",
          resultSequence: this.latestResultSequence(work.work_id),
          originTurnId: input.turnId,
          identity: `${input.mutationCallId}\0disposition`,
          now,
        });
      }

      this.db.query(`
        UPDATE btcc_guided_works SET status = ?, updated_at = ?
        WHERE work_id = ? AND status IN ('open', 'blocked')
      `).run(input.disposition, now, work.work_id);

      this.db.query(`
        INSERT INTO btcc_guided_work_disposition_commands (
          mutation_call_id, request_sha256, work_id,
          disposition_revision_id, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        input.mutationCallId,
        input.requestSha256,
        work.work_id,
        dispositionRevisionId,
        now,
      );
      const persisted = this.reader.view(work.work_id);
      const materialFingerprint = dispositionMaterialFingerprint(persisted);
      this.db.query(`
        UPDATE btcc_guided_work_disposition_revisions
        SET material_fingerprint = ?
        WHERE disposition_revision_id = ?
      `).run(materialFingerprint, dispositionRevisionId);
      return this.reader.view(work.work_id);
    }).immediate();
  }

  recordCloseoutMissing(input: RecordCloseoutMissingInput): void {
    this.db.transaction(() => {
      const work = this.sessions.requireBoundForCloseoutDiagnostic(input);
      if (work.work_id !== input.workId) {
        throw new Error("Durable Work closeout diagnostic target is not bound to this Turn");
      }
      const diagnosticKey = digest(
        `btcc-guided-work-closeout-missing.v1\0${input.turnId}\0${input.workId}`,
      );
      this.db.query(`
        INSERT OR IGNORE INTO btcc_guided_work_closeout_diagnostics (
          diagnostic_id, diagnostic_key, code, turn_id, work_id, created_at
        ) VALUES (?, ?, 'closeout_missing', ?, ?, ?)
      `).run(
        guidedWorkRecordId("diagnostic", diagnosticKey),
        diagnosticKey,
        input.turnId,
        input.workId,
        new Date().toISOString(),
      );
    }).immediate();
  }

  private replay(input: RecordWorkDispositionCommand): DurableWorkView | null {
    const row = this.db.query<{
      request_sha256: string;
      work_id: string;
      disposition_revision_id: string;
    }, [string]>(`
      SELECT request_sha256, work_id, disposition_revision_id
      FROM btcc_guided_work_disposition_commands
      WHERE mutation_call_id = ?
    `).get(input.mutationCallId);
    if (!row) return null;
    if (row.request_sha256 !== input.requestSha256 || row.work_id !== input.workId) {
      throw new Error(`Durable Work disposition identity conflict: ${input.mutationCallId}`);
    }
    return this.reader.view(row.work_id);
  }

  private attachCurrentTurnResults(
    workId: string,
    input: RecordWorkDispositionCommand,
  ): void {
    const ids = new Set<string>(input.backfillToolCallIds ?? []);
    const controlPlaceholders = CONTROL_TOOL_NAMES.map(() => "?").join(", ");
    const currentResults = this.db.query<{ call_id: string }, [string, ...string[]]>(`
      SELECT call_id FROM btcc_guided_tool_calls
      WHERE turn_id = ? AND status = 'completed'
        AND tool_name NOT IN (${controlPlaceholders})
      ORDER BY turn_sequence, rowid
    `).all(input.turnId, ...CONTROL_TOOL_NAMES);
    for (const result of currentResults) ids.add(result.call_id);
    for (const toolCallId of ids) {
      const row = this.db.query<{ work_id: string | null }, [string]>(`
        SELECT work_id FROM btcc_guided_work_results WHERE tool_call_id = ?
      `).get(toolCallId);
      if (row?.work_id && row.work_id !== workId) {
        throw new Error("Durable Work tool result is already bound to another Work");
      }
      if (row?.work_id === workId) continue;
      this.toolResults.attach(workId, {
        turnId: input.turnId,
        sessionId: input.sessionId,
        ...(input.projectRef ? { projectRef: input.projectRef } : {}),
        mutationCallId: `${input.mutationCallId}:backfill:${toolCallId}`,
        toolCallId,
      });
    }
  }

  private actionProgress(
    work: DurableWorkView,
    updates: DurableWorkDispositionActionUpdate[],
  ): DurableWorkActionProgress[] {
    for (const update of updates) {
      if (update.status !== "done" && update.status !== "skipped" &&
        update.status !== "blocked") {
        throw new Error(`Durable Work disposition action status is not terminal: ${update.actionKey}`);
      }
    }
    return updates.length > 0
      ? applyWorkActionUpdates(work, updates)
      : work.actionProgress;
  }

  private validateDisposition(input: {
    disposition: RecordWorkDispositionCommand["disposition"];
    actionProgress: DurableWorkActionProgress[];
    remainingActions: string[];
    nextCondition?: string;
    workId: string;
  }): void {
    if (input.disposition === "completed") {
      if (input.remainingActions.length > 0) {
        throw new Error("Completed Work cannot have remaining actions");
      }
      if (input.actionProgress.some((action) =>
        action.status !== "done" && action.status !== "skipped")) {
        throw new Error(`Completed Work has nonterminal actions: ${input.workId}`);
      }
      if (unresolvedEffectBlockersForWork(this.db, input.workId).length > 0) {
        throw new Error("Completed Work has an unresolved effect blocker");
      }
      const placeholders = ACTIVE_EFFECT_STATUSES.map(() => "?").join(", ");
      const pending = this.db.query<{ present: number }, [string, ...string[]]>(`
        SELECT 1 AS present FROM btcc_guided_effects
        WHERE work_id = ? AND status IN (${placeholders}) LIMIT 1
      `).get(input.workId, ...ACTIVE_EFFECT_STATUSES);
      if (pending) {
        throw new Error("Completed Work has a pending effect");
      }
      return;
    }
    if (input.remainingActions.length === 0 && !input.nextCondition) {
      throw new Error(
        `${input.disposition} Work requires remaining actions or a next condition`,
      );
    }
    if (input.disposition === "blocked" && !input.nextCondition) {
      throw new Error("Blocked Work requires a concrete next condition");
    }
  }

  private nextRevision(workId: string): number {
    return this.db.query<{ revision: number }, [string]>(`
      SELECT COALESCE(MAX(revision), 0) + 1 AS revision
      FROM btcc_guided_work_disposition_revisions WHERE work_id = ?
    `).get(workId)?.revision ?? 1;
  }

  private latestResultSequence(workId: string): number {
    return this.db.query<{ sequence: number }, [string]>(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM btcc_guided_work_results WHERE work_id = ?
    `).get(workId)?.sequence ?? 0;
  }
}
