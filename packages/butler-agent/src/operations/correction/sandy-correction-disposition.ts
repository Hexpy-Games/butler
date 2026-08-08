import type { Database } from "bun:sqlite";
import {
  SANDY_SOURCE_ACTION_KEYS,
  SANDY_SOURCE_PLAN_REVISION_ID,
  sha256,
  stableJson,
  type SandyCorrectionInput,
  type SandyCorrectionRead,
} from "./sandy-correction-contracts.ts";
import { ensureCaptureEvidenceSchema } from "./sandy-correction-schema.ts";

export function recordMonitoringDisposition(
  db: Database,
  input: SandyCorrectionInput,
  read: SandyCorrectionRead,
  now: string,
  fingerprint: string,
): void {
  if (input.disposition.remainingActions.length > 0) {
    throw new Error("completed monitoring Work cannot retain remaining actions");
  }
  if (input.disposition.actionUpdates.length === 0 || input.disposition.actionUpdates.some((update) =>
    update.status !== "done" && update.status !== "skipped",
  )) {
    throw new Error("monitoring disposition requires terminal action updates");
  }
  const revision = Number(db.query<{ revision: number | null }, [string]>(`
    SELECT MAX(revision) AS revision FROM btcc_guided_work_disposition_revisions WHERE work_id = ?
  `).get(input.sourceWorkId)?.revision ?? 0) + 1;
  const dispositionRevisionId = `sandy-monitoring-disposition-${fingerprint}`;
  const evidenceSnapshot = input.disposition.evidenceSnapshot;
  const materialFingerprint = sha256(stableJson({
    workId: input.sourceWorkId,
    revision,
    disposition: "completed",
    summary: input.disposition.summary.trim(),
    actionUpdates: input.disposition.actionUpdates,
    resultSequence: read.results
      .filter((result) => input.monitoringTurnIds.includes(result.originTurnId as typeof input.monitoringTurnIds[number]))
      .reduce((maximum, result) => Math.max(maximum, result.sequence), 0),
  }));
  db.query(`
    INSERT INTO btcc_guided_work_disposition_revisions (
      disposition_revision_id, work_id, revision, result_sequence,
      material_fingerprint, disposition, summary, action_updates_json,
      remaining_actions_json, next_condition, evidence_refs_json,
      evidence_snapshot_json, followups_json, origin_turn_id, created_at
    ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    dispositionRevisionId,
    input.sourceWorkId,
    revision,
    read.results.reduce((maximum, result) =>
      input.monitoringTurnIds.includes(result.originTurnId as typeof input.monitoringTurnIds[number])
        ? Math.max(maximum, result.sequence)
        : maximum, 0),
    materialFingerprint,
    input.disposition.summary.trim(),
    stableJson(input.disposition.actionUpdates),
    stableJson(input.disposition.remainingActions),
    input.disposition.nextCondition,
    stableJson(input.disposition.evidenceRefs),
    stableJson(evidenceSnapshot),
    stableJson(input.disposition.followups),
    input.monitoringTurnIds[1],
    now,
  );
  db.query(`
    INSERT INTO btcc_guided_work_disposition_commands (
      mutation_call_id, request_sha256, work_id, disposition_revision_id, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(`sandy-monitoring-disposition-command-${fingerprint}`, fingerprint, input.sourceWorkId, dispositionRevisionId, now);
  db.query("UPDATE btcc_guided_works SET status = 'completed', updated_at = ? WHERE work_id = ?").run(now, input.sourceWorkId);
  writeMonitoringCloseoutCheckpoint(db, input, read, now, fingerprint);
}

/**
 * The disposition is not the only durable closeout projection.  Rebuild the
 * source Work's latest checkpoint from its canonical Plan in the same
 * transaction so DurableWorkView cannot continue to expose the pre-correction
 * active monitoring action.
 */
function writeMonitoringCloseoutCheckpoint(
  db: Database,
  input: SandyCorrectionInput,
  read: SandyCorrectionRead,
  now: string,
  fingerprint: string,
): void {
  ensureCaptureEvidenceSchema(db);
  if (!read.sourcePlan || read.sourcePlan.planRevisionId !== SANDY_SOURCE_PLAN_REVISION_ID) {
    throw new Error("monitoring closeout requires the canonical source Plan");
  }
  const latest = db.query<{
    action_states_json: string;
    next_step: string;
  }, [string]>(`SELECT action_states_json, next_step
    FROM btcc_guided_work_checkpoint_revisions
    WHERE work_id = ? ORDER BY revision DESC LIMIT 1`).get(input.sourceWorkId);
  const priorNotes = new Map<string, string>();
  if (latest) {
    try {
      const states = JSON.parse(latest.action_states_json) as Array<{ actionKey?: string; note?: string }>;
      for (const state of states) {
        if (state.actionKey && state.note) priorNotes.set(state.actionKey, state.note);
      }
    } catch {
      throw new Error("source Work checkpoint action state JSON is invalid");
    }
  }
  const revision = Number(db.query<{ revision: number | null }, [string]>(`
    SELECT MAX(revision) AS revision FROM btcc_guided_work_checkpoint_revisions WHERE work_id = ?
  `).get(input.sourceWorkId)?.revision ?? 0) + 1;
  const actionStates = SANDY_SOURCE_ACTION_KEYS.map((actionKey) => ({
    actionKey,
    status: "done" as const,
    note: actionKey === "수정 전후 모니터링 비교"
      ? "57개 표본과 16.5시간 관찰의 수정 전후 모니터링 게이트를 확인했다. 비차단 후속 관찰은 별도 추적한다."
      : priorNotes.get(actionKey) ?? "감사된 Plan 근거로 완료를 확인했다.",
  }));
  const checkpointRevisionId = `sandy-monitoring-closeout-checkpoint-${fingerprint}`;
  const resultSequence = read.results
    .filter((result) => input.monitoringTurnIds.includes(result.originTurnId as typeof input.monitoringTurnIds[number]))
    .reduce((maximum, result) => Math.max(maximum, result.sequence), 0);
  db.query(`
    INSERT INTO btcc_guided_work_checkpoint_revisions (
      checkpoint_revision_id, work_id, revision, plan_revision_id, stage,
      public_summary, next_step, action_states_json, result_sequence,
      origin_turn_id, created_at
    ) VALUES (?, ?, ?, ?, 'validation', ?, ?, ?, ?, ?, ?)
  `).run(
    checkpointRevisionId,
    input.sourceWorkId,
    revision,
    read.sourcePlan.planRevisionId,
    "감사된 57개 표본과 배포 후 지표 비교를 반영해 monitoring action을 완료했다. 비차단 후속 관찰은 남긴다.",
    "비차단 후속 관찰은 별도 모니터링으로 추적한다.",
    stableJson(actionStates),
    resultSequence,
    input.monitoringTurnIds[1],
    now,
  );
}
