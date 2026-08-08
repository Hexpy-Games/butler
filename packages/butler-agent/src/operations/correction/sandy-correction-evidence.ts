import type { Database } from "bun:sqlite";
import {
  defaultCaptureCheckpoint,
  defaultCapturePlan,
  sha256,
  stableJson,
  type SandyCorrectionInput,
  type SandyCorrectionRead,
  type SandyResultRow,
  type SandyWorkRow,
} from "./sandy-correction-contracts.ts";
import { ensureCaptureEvidenceSchema } from "./sandy-correction-schema.ts";

export function createCaptureWork(
  db: Database,
  input: SandyCorrectionInput,
  read: SandyCorrectionRead,
  now: string,
): SandyWorkRow {
  const firstTurn = read.turnMessages.find((message) => message.turnId === input.captureTurnIds[0]);
  if (!firstTurn) throw new Error("first capture Turn request is unavailable");
  const captureWorkId = `guided-work-${sha256(stableJson({
    version: 1,
    sourceWorkId: input.sourceWorkId,
    captureTurnIds: input.captureTurnIds,
  })).slice(0, 64)}`;
  const existing = db.query<{ work_id: string }, [string]>(
    "SELECT work_id FROM btcc_guided_works WHERE work_id = ?",
  ).get(captureWorkId);
  if (existing) throw new Error(`deterministic capture Work already exists without audit: ${captureWorkId}`);
  const createdAt = read.bindings
    .filter((binding) => binding.turnId === input.captureTurnIds[0])
    .sort((left, right) => left.boundAt.localeCompare(right.boundAt))[0]?.boundAt ?? now;
  db.query(`
    INSERT INTO btcc_guided_works (
      work_id, session_id, scope_kind, scope_ref, origin_turn_id,
      origin_message_id, objective, status, current_plan_revision_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?)
  `).run(
    captureWorkId,
    input.sessionId,
    read.sourceWork.scopeKind,
    read.sourceWork.scopeRef,
    input.captureTurnIds[0],
    firstTurn.originalMessageId,
    firstTurn.originalMessage,
    createdAt,
    now,
  );
  return {
    ...read.sourceWork,
    workId: captureWorkId,
    originTurnId: input.captureTurnIds[0],
    originMessageId: firstTurn.originalMessageId,
    objective: firstTurn.originalMessage,
    status: "open",
    currentPlanRevisionId: null,
    createdAt,
    updatedAt: now,
  };
}

export function moveCaptureBindings(db: Database, input: SandyCorrectionInput, captureWorkId: string): void {
  const placeholders = input.captureTurnIds.map(() => "?").join(", ");
  const args = [captureWorkId, input.sessionId, input.sourceWorkId, ...input.captureTurnIds];
  const result = db.query(`
    UPDATE btcc_guided_turn_work_bindings
    SET work_id = ?
    WHERE session_id = ? AND work_id = ? AND is_current = 1
      AND turn_id IN (${placeholders})
  `).run(...args);
  if (result.changes !== 2) throw new Error("capture binding move did not affect exactly two current bindings");
}

export function moveCaptureResults(
  db: Database,
  input: SandyCorrectionInput,
  sourceResults: readonly SandyResultRow[],
  captureWorkId: string,
): void {
  const rows = sourceResults
    .filter((result) => input.captureTurnIds.includes(result.originTurnId as typeof input.captureTurnIds[number]))
    .sort((left, right) => left.sequence - right.sequence);
  if (rows.length === 0) throw new Error("capture Turns contain no results");
  rows.forEach((result, index) => {
    const update = db.query(`
      UPDATE btcc_guided_work_results SET work_id = ?, sequence = ?
      WHERE result_ref = ? AND work_id = ?
    `).run(captureWorkId, index + 1, result.resultRef, input.sourceWorkId);
    if (update.changes !== 1) {
      throw new Error(`capture result move did not affect exactly one result: ${result.resultRef}`);
    }
  });
}

export function createCapturePlanAndCheckpoint(
  db: Database,
  input: SandyCorrectionInput,
  captureWork: SandyWorkRow,
  now: string,
  fingerprint: string,
): SandyWorkRow {
  const plan = input.capturePlan ?? defaultCapturePlan();
  const checkpoint = input.captureCheckpoint ?? defaultCaptureCheckpoint(input.captureTurnIds[1]);
  if (plan.actions.length === 0 || plan.checks.length === 0) {
    throw new Error("capture Work requires an evidence-grounded plan and checks");
  }
  if (plan.actions.some((action) => action.status === "done" && !action.note)) {
    throw new Error("capture plan completion requires an evidence note");
  }
  if (checkpoint.originTurnId !== input.captureTurnIds[1]) {
    throw new Error("capture checkpoint must be authored by the follow-up capture Turn");
  }
  ensureCaptureEvidenceSchema(db);
  const planRevisionId = `sandy-capture-plan-${fingerprint}`;
  const checkpointRevisionId = `sandy-capture-checkpoint-${fingerprint}`;
  const actions = plan.actions.map(({ actionKey, description, dependencyKeys }) => ({
    actionKey,
    description,
    dependencyKeys,
  }));
  db.query(`
    INSERT INTO btcc_guided_work_plan_revisions (
      plan_revision_id, work_id, revision, objective, governing_refs_json,
      actions_json, checks_json, origin_turn_id, created_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
  `).run(
    planRevisionId,
    captureWork.workId,
    plan.objective,
    stableJson(plan.governingRefs),
    stableJson(actions),
    stableJson(plan.checks),
    input.captureTurnIds[0],
    now,
  );
  db.query("UPDATE btcc_guided_works SET current_plan_revision_id = ?, updated_at = ? WHERE work_id = ?")
    .run(planRevisionId, now, captureWork.workId);
  const resultSequence = db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) AS count FROM btcc_guided_work_results WHERE work_id = ?",
  ).get(captureWork.workId)?.count ?? 0;
  db.query(`
    INSERT INTO btcc_guided_work_checkpoint_revisions (
      checkpoint_revision_id, work_id, revision, plan_revision_id, stage,
      public_summary, next_step, action_states_json, result_sequence,
      origin_turn_id, created_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    checkpointRevisionId,
    captureWork.workId,
    planRevisionId,
    checkpoint.stage,
    checkpoint.publicSummary,
    checkpoint.nextStep,
    stableJson(checkpoint.actionProgress),
    resultSequence,
    checkpoint.originTurnId,
    now,
  );
  return { ...captureWork, currentPlanRevisionId: planRevisionId, updatedAt: now };
}
