import { Database } from "bun:sqlite";
import {
  SANDY_CAPTURE_TURN_IDS,
  SANDY_EXPECTED_RESULT_COUNTS,
  SANDY_MONITORING_TURN_IDS,
  SANDY_SOURCE_ACTION_KEYS,
  SANDY_SOURCE_PLAN_REVISION_ID,
  sha256,
  stableJson,
  type SandyAfterSnapshot,
  type SandyCorrectionInput,
  type SandyCorrectionRead,
  type SandyCorrectionResult,
  type SandyWorkRow,
} from "./sandy-correction-contracts.ts";
import { hasColumn, hasTable } from "./sandy-correction-schema.ts";
import { digestSelectedToolJournal } from "./sandy-correction-snapshot.ts";

export function assertLiveSource(
  db: Database,
  input: SandyCorrectionInput,
  read: SandyCorrectionRead,
): void {
  const work = db.query<{ work_id: string; status: string; session_id: string }, [string]>(`
    SELECT work_id, status, session_id FROM btcc_guided_works WHERE work_id = ?
  `).get(input.sourceWorkId);
  if (!work || work.session_id !== input.sessionId || work.status !== "open") {
    throw new Error("source Work changed before apply; refusing correction");
  }
  const bindings = Number(db.query<{ count: number }, [string, string]>(`
    SELECT COUNT(*) AS count FROM btcc_guided_turn_work_bindings
    WHERE session_id = ? AND work_id = ? AND is_current = 1
  `).get(input.sessionId, input.sourceWorkId)?.count ?? -1);
  const results = Number(db.query<{ count: number }, [string]>(`
    SELECT COUNT(*) AS count FROM btcc_guided_work_results WHERE work_id = ?
  `).get(input.sourceWorkId)?.count ?? -1);
  if (bindings !== read.sourceBindingCount || results !== read.sourceResultCount) {
    throw new Error("source Work changed after dry-run; refusing correction");
  }
  if (hasTable(db, "btcc_guided_effects")) {
    const nonApplied = db.query<{ status: string }, [string]>(`
      SELECT status FROM btcc_guided_effects
      WHERE work_id = ? AND status <> 'applied' LIMIT 1
    `).get(input.sourceWorkId);
    if (nonApplied) {
      throw new Error(`source Work has a non-applied effect (${nonApplied.status}); refusing correction`);
    }
  }
}

export function updateSessionHead(db: Database, sessionId: string, workId: string, now: string): void {
  if (!hasTable(db, "btcc_guided_work_session_heads")) return;
  const result = db.query(`
    UPDATE btcc_guided_work_session_heads SET work_id = ?, updated_at = ? WHERE session_id = ?
  `).run(workId, now, sessionId);
  if (result.changes === 0) {
    db.query("INSERT INTO btcc_guided_work_session_heads (session_id, work_id, updated_at) VALUES (?, ?, ?)")
      .run(sessionId, workId, now);
  }
}

export function assertTransactionPostconditions(
  db: Database,
  input: SandyCorrectionInput,
  before: SandyCorrectionRead,
  captureWorkId: string,
  requireAudit: boolean,
): void {
  const source = db.query<{ status: string; scope_kind: string; scope_ref: string }, [string]>(
    "SELECT status, scope_kind, scope_ref FROM btcc_guided_works WHERE work_id = ?",
  ).get(input.sourceWorkId);
  const capture = db.query<{ status: string; current_plan_revision_id: string | null }, [string]>(
    "SELECT status, current_plan_revision_id FROM btcc_guided_works WHERE work_id = ?",
  ).get(captureWorkId);
  if (!source || source.status !== "completed" || !capture || capture.status !== "open" || !capture.current_plan_revision_id) {
    throw new Error("correction Work status/plan postcondition failed");
  }
  if (source.scope_kind !== before.sourceWork.scopeKind || source.scope_ref !== before.sourceWork.scopeRef) {
    throw new Error("source Work scope changed during correction");
  }
  const bindings = db.query<{
    turn_id: string;
    work_id: string;
    revision: number;
    is_current: number;
  }, string[]>(`
    SELECT turn_id, work_id, revision, is_current
    FROM btcc_guided_turn_work_bindings
    WHERE session_id = ? AND turn_id IN (?, ?, ?, ?) AND is_current = 1
    ORDER BY turn_id
  `).all(input.sessionId, ...input.monitoringTurnIds, ...input.captureTurnIds);
  if (bindings.length !== 4 || new Set(bindings.map((row) => row.turn_id)).size !== 4 || bindings.some((row) => row.revision < 1)) {
    throw new Error("binding postcondition has missing/duplicate current Turn rows");
  }
  if (bindings.filter((row) => row.work_id === input.sourceWorkId).length !== 2 ||
    bindings.filter((row) => row.work_id === captureWorkId).length !== 2 ||
    bindings.some((row) => row.work_id === input.sourceWorkId && !input.monitoringTurnIds.includes(row.turn_id as typeof input.monitoringTurnIds[number])) ||
    bindings.some((row) => row.work_id === captureWorkId && !input.captureTurnIds.includes(row.turn_id as typeof input.captureTurnIds[number]))) {
    throw new Error("binding postcondition has incorrect Work/Turn assignment");
  }
  const actualResults = readResultIdentities(db, [input.sourceWorkId, captureWorkId]);
  const expectedMonitoring = before.results
    .filter((row) => input.monitoringTurnIds.includes(row.originTurnId as typeof input.monitoringTurnIds[number]))
    .map((row, index) => ({ ...row, workId: input.sourceWorkId, sequence: index + 1,
      toolStatus: row.toolStatus ?? null, toolResultSha256: row.toolResultSha256 ?? null }));
  const expectedCapture = before.results
    .filter((row) => input.captureTurnIds.includes(row.originTurnId as typeof input.captureTurnIds[number]))
    .map((row, index) => ({ ...row, workId: captureWorkId, sequence: index + 1,
      toolStatus: row.toolStatus ?? null, toolResultSha256: row.toolResultSha256 ?? null }));
  const expectedResults = [...expectedMonitoring, ...expectedCapture];
  if (actualResults.length !== before.sourceResultCount || expectedResults.length !== before.sourceResultCount ||
    actualResults.length !== new Set(actualResults.map((row) => row.resultRef)).size ||
    actualResults.length !== new Set(actualResults.map((row) => row.toolCallId)).size ||
    !sameResultIdentities(actualResults, expectedResults)) {
    throw new Error("result postcondition changed a result identity, hash, order, or duplicate");
  }
  const journalCount = hasTable(db, "btcc_guided_tool_calls")
    ? Number(db.query<{ count: number }, string[]>("SELECT COUNT(*) AS count FROM btcc_guided_tool_calls WHERE turn_id IN (?, ?, ?, ?)")
      .get(...input.monitoringTurnIds, ...input.captureTurnIds)?.count ?? 0)
    : 0;
  if (journalCount !== before.selectedToolJournalCount) {
    throw new Error("selected raw tool journal count changed during correction");
  }
  if (digestSelectedToolJournal(db, input) !== before.selectedToolJournalDigest) {
    throw new Error("selected raw tool journal identity changed during correction");
  }
  if (countWorkResults(db, input.sourceWorkId) !== SANDY_EXPECTED_RESULT_COUNTS[SANDY_MONITORING_TURN_IDS[0]] + SANDY_EXPECTED_RESULT_COUNTS[SANDY_MONITORING_TURN_IDS[1]] ||
    countWorkResults(db, captureWorkId) !== SANDY_EXPECTED_RESULT_COUNTS[SANDY_CAPTURE_TURN_IDS[0]] + SANDY_EXPECTED_RESULT_COUNTS[SANDY_CAPTURE_TURN_IDS[1]]) {
    throw new Error("source/capture result count postcondition failed");
  }
  const head = hasTable(db, "btcc_guided_work_session_heads")
    ? db.query<{ work_id: string }, [string]>("SELECT work_id FROM btcc_guided_work_session_heads WHERE session_id = ?").get(input.sessionId)?.work_id
    : captureWorkId;
  if (head !== captureWorkId) throw new Error("session head postcondition failed");
  if (db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM btcc_guided_work_plan_revisions WHERE work_id = ?").get(captureWorkId)?.count !== 1 ||
    db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM btcc_guided_work_checkpoint_revisions WHERE work_id = ?").get(captureWorkId)?.count !== 1 ||
    db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM btcc_guided_work_disposition_revisions WHERE work_id = ? AND disposition = 'completed'").get(input.sourceWorkId)?.count !== 1) {
    throw new Error("plan/checkpoint/disposition postcondition failed");
  }
  const sourcePlan = db.query<{ plan_revision_id: string }, [string]>(`
    SELECT current_plan_revision_id AS plan_revision_id FROM btcc_guided_works WHERE work_id = ?
  `).get(input.sourceWorkId);
  const sourceCheckpoint = db.query<{
    plan_revision_id: string;
    result_sequence: number;
    action_states_json: string;
  }, [string]>(`SELECT plan_revision_id, result_sequence, action_states_json
    FROM btcc_guided_work_checkpoint_revisions WHERE work_id = ? ORDER BY revision DESC LIMIT 1`).get(input.sourceWorkId);
  if (sourcePlan?.plan_revision_id !== SANDY_SOURCE_PLAN_REVISION_ID || !sourceCheckpoint ||
    sourceCheckpoint.plan_revision_id !== SANDY_SOURCE_PLAN_REVISION_ID ||
    sourceCheckpoint.result_sequence !==
      SANDY_EXPECTED_RESULT_COUNTS[SANDY_MONITORING_TURN_IDS[0]] +
      SANDY_EXPECTED_RESULT_COUNTS[SANDY_MONITORING_TURN_IDS[1]] ||
    !hasAllDoneSourceActions(sourceCheckpoint.action_states_json)) {
    throw new Error("monitoring closeout checkpoint postcondition failed");
  }
  if (requireAudit && db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM btcc_operator_correction_audits").get()?.count !== 1) {
    throw new Error("correction audit postcondition failed");
  }
}

export function buildAfterSnapshot(
  db: Database,
  input: SandyCorrectionInput,
  captureWork: SandyWorkRow,
  fingerprint: string,
): SandyAfterSnapshot & { afterSnapshotSha256: string } {
  const sourceWork = readWorkForApply(db, input.sourceWorkId);
  const monitoringResultCount = countResultsForTurns(db, input.sourceWorkId, input.monitoringTurnIds);
  const captureResultCount = countResultsForTurns(db, captureWork.workId, input.captureTurnIds);
  const monitoringBindingCount = countBindingsForTurns(db, input.sessionId, input.sourceWorkId, input.monitoringTurnIds);
  const captureBindingCount = countBindingsForTurns(db, input.sessionId, captureWork.workId, input.captureTurnIds);
  const monitoringResultSequence = resultSequences(db, input.sourceWorkId);
  const captureResultSequence = resultSequences(db, captureWork.workId);
  const sessionHeadWorkId = hasTable(db, "btcc_guided_work_session_heads")
    ? db.query<{ work_id: string }, [string]>("SELECT work_id FROM btcc_guided_work_session_heads WHERE session_id = ?").get(input.sessionId)?.work_id ?? null
    : null;
  const snapshot: SandyAfterSnapshot = {
    sourceWork,
    captureWork: { ...captureWork, updatedAt: sourceWork.updatedAt },
    sessionHeadWorkId,
    monitoringBindingCount,
    captureBindingCount,
    monitoringResultCount,
    captureResultCount,
    monitoringResultSequence,
    captureResultSequence,
    dispositionRevisionId: `sandy-monitoring-disposition-${fingerprint}`,
  };
  return { ...snapshot, afterSnapshotSha256: sha256(stableJson(snapshot)) };
}

export function insertCorrectionAudit(input: {
  db: Database;
  auditId: string;
  requestFingerprint: string;
  input: SandyCorrectionInput;
  read: SandyCorrectionRead;
  after: SandyAfterSnapshot & { afterSnapshotSha256: string };
  backup: SandyCorrectionResult["backup"];
  now: string;
}): void {
  input.db.query(`
    INSERT INTO btcc_operator_correction_audits (
      audit_id, request_fingerprint, correction_version, session_id, source_work_id,
      monitoring_turn_ids_json, capture_turn_ids_json, source_db_identity_json,
      before_snapshot_sha256, after_snapshot_sha256, before_snapshot_json,
      after_snapshot_json, before_counts_json, after_counts_json,
      operator_id, operator_reason, backup_identity, backup_json, created_at
    ) VALUES (?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.auditId,
    input.requestFingerprint,
    input.input.sessionId,
    input.input.sourceWorkId,
    stableJson(input.input.monitoringTurnIds),
    stableJson(input.input.captureTurnIds),
    stableJson(input.read.identity),
    input.read.beforeSnapshotSha256,
    input.after.afterSnapshotSha256,
    stableJson({
      sourceWorkId: input.read.sourceWork.workId,
      sessionHeadWorkId: input.read.sessionHeadWorkId,
      bindingDigest: input.read.bindingDigest,
      resultDigest: input.read.resultDigest,
      bindingCount: input.read.sourceBindingCount,
      resultCount: input.read.sourceResultCount,
      captureResultCount: input.read.captureResultCount,
    }),
    stableJson(stripAfterSnapshotHash(input.after)),
    stableJson({ bindings: input.read.sourceBindingCount, results: input.read.sourceResultCount }),
    stableJson({
      monitoringBindings: input.after.monitoringBindingCount,
      captureBindings: input.after.captureBindingCount,
      monitoringResults: input.after.monitoringResultCount,
      captureResults: input.after.captureResultCount,
    }),
    input.input.operatorId?.trim() ?? "",
    input.input.operatorReason.trim(),
    input.backup?.bundleIdentity ?? "",
    stableJson(input.backup ?? null),
    input.now,
  );
}

function stripAfterSnapshotHash(after: SandyAfterSnapshot & { afterSnapshotSha256: string }): SandyAfterSnapshot {
  const { afterSnapshotSha256: _ignored, ...snapshot } = after;
  return snapshot;
}

function readWorkForApply(db: Database, workId: string): SandyWorkRow {
  const row = db.query<{
    work_id: string; session_id: string; scope_kind: string; scope_ref: string;
    origin_turn_id: string; origin_message_id: string; objective: string; status: string;
    current_plan_revision_id: string | null; created_at: string; updated_at: string;
  }, [string]>(`SELECT work_id, session_id, scope_kind, scope_ref, origin_turn_id,
    origin_message_id, objective, status, current_plan_revision_id, created_at, updated_at
    FROM btcc_guided_works WHERE work_id = ?`).get(workId);
  if (!row) throw new Error(`Work disappeared during correction: ${workId}`);
  return {
    workId: row.work_id, sessionId: row.session_id, scopeKind: row.scope_kind, scopeRef: row.scope_ref,
    originTurnId: row.origin_turn_id, originMessageId: row.origin_message_id, objective: row.objective,
    status: row.status, currentPlanRevisionId: row.current_plan_revision_id,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function countBindingsForTurns(db: Database, sessionId: string, workId: string, turns: readonly string[]): number {
  const placeholders = turns.map(() => "?").join(", ");
  return Number(db.query<{ count: number }, string[]>(`
    SELECT COUNT(*) AS count FROM btcc_guided_turn_work_bindings
    WHERE session_id = ? AND work_id = ? AND is_current = 1 AND turn_id IN (${placeholders})
  `).get(sessionId, workId, ...turns)?.count ?? 0);
}

function countResultsForTurns(db: Database, workId: string, turns: readonly string[]): number {
  const placeholders = turns.map(() => "?").join(", ");
  return Number(db.query<{ count: number }, string[]>(`
    SELECT COUNT(*) AS count FROM btcc_guided_work_results
    WHERE work_id = ? AND origin_turn_id IN (${placeholders})
  `).get(workId, ...turns)?.count ?? 0);
}

function resultSequences(db: Database, workId: string): number[] {
  return db.query<{ sequence: number }, [string]>(
    "SELECT sequence FROM btcc_guided_work_results WHERE work_id = ? ORDER BY sequence",
  ).all(workId).map((row) => row.sequence);
}

type ResultIdentity = {
  resultRef: string;
  workId: string;
  sequence: number;
  toolCallId: string;
  originTurnId: string;
  attachedAt: string;
  toolStatus: string | null;
  toolResultSha256: string | null;
};

function readResultIdentities(db: Database, workIds: readonly string[]): ResultIdentity[] {
  const hasResultHash = hasColumn(db, "btcc_guided_tool_calls", "result_sha256");
  const rows = db.query<ResultIdentity, string[]>(`
    SELECT results.result_ref AS resultRef, results.work_id AS workId,
      results.sequence AS sequence, results.tool_call_id AS toolCallId,
      results.origin_turn_id AS originTurnId, results.attached_at AS attachedAt,
      calls.status AS toolStatus, ${hasResultHash ? "calls.result_sha256" : "NULL"} AS toolResultSha256
    FROM btcc_guided_work_results results
    LEFT JOIN btcc_guided_tool_calls calls ON calls.call_id = results.tool_call_id
    WHERE results.work_id IN (?, ?)
    ORDER BY results.work_id, results.sequence
  `).all(...workIds);
  return rows;
}

function hasAllDoneSourceActions(actionStatesJson: string): boolean {
  try {
    const states = JSON.parse(actionStatesJson) as Array<{ actionKey?: string; status?: string }>;
    return states.length === SANDY_SOURCE_ACTION_KEYS.length && states.every((state, index) =>
      state.actionKey === SANDY_SOURCE_ACTION_KEYS[index] && state.status === "done");
  } catch {
    return false;
  }
}

function sameResultIdentities(
  actual: readonly ResultIdentity[],
  expected: ReadonlyArray<{
    resultRef: string;
    workId: string;
    sequence: number;
    toolCallId: string;
    originTurnId: string;
    attachedAt: string;
    toolStatus?: string | null;
    toolResultSha256?: string | null;
  }>,
): boolean {
  if (actual.length !== expected.length) return false;
  const normalize = (row: {
    resultRef: string;
    workId: string;
    sequence: number;
    toolCallId: string;
    originTurnId: string;
    attachedAt: string;
    toolStatus?: string | null;
    toolResultSha256?: string | null;
  }) => stableJson({
    resultRef: row.resultRef,
    workId: row.workId,
    sequence: row.sequence,
    toolCallId: row.toolCallId,
    originTurnId: row.originTurnId,
    attachedAt: row.attachedAt,
    toolStatus: row.toolStatus ?? null,
    toolResultSha256: row.toolResultSha256 ?? null,
  });
  return actual.map(normalize).sort().every((value, index) => value === expected.map(normalize).sort()[index]);
}

function countWorkResults(db: Database, workId: string): number {
  return Number(db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) AS count FROM btcc_guided_work_results WHERE work_id = ?",
  ).get(workId)?.count ?? 0);
}
