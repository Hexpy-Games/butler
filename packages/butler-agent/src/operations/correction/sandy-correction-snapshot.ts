import { Database } from "bun:sqlite";
import {
  sha256,
  stableJson,
  SANDY_CAPTURE_OBJECTIVE,
  SANDY_CAPTURE_TURN_IDS,
  SANDY_EXPECTED_RESULT_COUNTS,
  SANDY_MONITORING_TURN_IDS,
  SANDY_SOURCE_ACTION_KEYS,
  SANDY_SOURCE_CURRENT_ACTION_STATUSES,
  SANDY_SOURCE_CURRENT_RESULT_SEQUENCE,
  SANDY_SELECTED_TOOL_JOURNAL_COUNT,
  SANDY_SOURCE_OBJECTIVE,
  SANDY_SOURCE_PLAN_CHECKS,
  SANDY_SOURCE_PLAN_REVISION,
  SANDY_SOURCE_PLAN_REVISION_ID,
  SANDY_SOURCE_SCOPE_KIND,
  SANDY_SOURCE_SCOPE_REF,
  type SandyBindingRow,
  type SandyBeforeSnapshot,
  type SandyCorrectionRead,
  type SandyCorrectionTarget,
  type SandyCheckpointSnapshot,
  type SandyPlanSnapshot,
  type SandyResultRow,
  type SandyTurnMessage,
  type SandyWorkRow,
} from "./sandy-correction-contracts.ts";
import { readDatabaseIdentity } from "./sandy-correction-identity.ts";
import { hasColumn, hasTable } from "./sandy-correction-schema.ts";

type WorkSqlRow = {
  work_id: string;
  session_id: string;
  scope_kind: string;
  scope_ref: string;
  origin_turn_id: string;
  origin_message_id: string;
  objective: string;
  status: string;
  current_plan_revision_id: string | null;
  created_at: string;
  updated_at: string;
};

type BindingSqlRow = {
  binding_revision_id: string;
  turn_id: string;
  session_id: string;
  work_id: string;
  revision: number;
  is_current: number;
  bound_at: string;
};

type ResultSqlRow = {
  result_ref: string;
  work_id: string;
  sequence: number;
  tool_call_id: string;
  origin_turn_id: string;
  attached_at: string;
  tool_status: string | null;
  tool_result_sha256: string | null;
};

type TurnSqlRow = {
  turn_id: string;
  original_message_id: string | null;
  original_message: string | null;
};

export function readSandyCorrection(input: SandyCorrectionTarget): SandyCorrectionRead {
  assertTarget(input);
  const db = new Database(input.dbPath, { readonly: true });
  try {
    return readSandyCorrectionFromDatabase(db, input);
  } finally {
    db.close();
  }
}

export function readSandyCorrectionFromDatabase(
  db: Database,
  input: SandyCorrectionTarget,
): SandyCorrectionRead {
  assertTarget(input);
  assertRequiredTables(db);
  const sourceWork = readWork(db, input.sourceWorkId);
  if (!sourceWork) throw new Error(`source Work not found: ${input.sourceWorkId}`);
  if (sourceWork.sessionId !== input.sessionId) {
    throw new Error("source Work session identity does not match correction target");
  }
  const bindings = readBindings(db, input.sessionId, input.sourceWorkId);
  const results = readResults(db, input.sourceWorkId);
  assertSelectedToolJournalRows(db, input);
  const sourcePlan = readPlan(db, sourceWork);
  const sourceCheckpoint = readCheckpoint(db, sourceWork);
  const turnMessages = readTurnMessages(db, [
    ...input.monitoringTurnIds,
    ...input.captureTurnIds,
  ]);
  const sessionHeadWorkId = readSessionHead(db, input.sessionId);
  const beforeSnapshot: SandyBeforeSnapshot = {
    sourceWork,
    sourcePlan,
    sourceCheckpoint,
    sessionHeadWorkId,
    bindings,
    results,
    turnMessages,
    selectedToolJournalCount: readSelectedToolJournalCount(db, input),
    selectedToolJournalDigest: digestSelectedToolJournal(db, input),
  };
  const bindingDigest = digestBindings(bindings);
  const resultDigest = digestResults(results);
  const beforeSnapshotSha256 = sha256(stableJson(beforeSnapshot));
  return {
    target: {
      dbPath: input.dbPath,
      sessionId: input.sessionId,
      sourceWorkId: input.sourceWorkId,
      monitoringTurnIds: [...input.monitoringTurnIds] as [string, string],
      captureTurnIds: [...input.captureTurnIds] as [string, string],
    },
    identity: readDatabaseIdentity(input.dbPath, db),
    sourceWork,
    sourcePlan,
    sourceCheckpoint,
    sessionHeadWorkId,
    bindings,
    results,
    turnMessages,
    sourceResultCount: results.length,
    sourceBindingCount: bindings.filter((binding) => binding.isCurrent === 1).length,
    monitoringResultCount: results.filter((result) =>
      input.monitoringTurnIds.includes(result.originTurnId as typeof input.monitoringTurnIds[number]),
    ).length,
    captureResultCount: results.filter((result) =>
      input.captureTurnIds.includes(result.originTurnId as typeof input.captureTurnIds[number]),
    ).length,
    resultCountByTurn: Object.fromEntries(
      [...new Set(results.map((result) => result.originTurnId))]
        .map((turnId) => [turnId, results.filter((result) => result.originTurnId === turnId).length]),
    ),
    selectedToolJournalCount: beforeSnapshot.selectedToolJournalCount,
    selectedToolJournalDigest: beforeSnapshot.selectedToolJournalDigest,
    bindingDigest,
    resultDigest,
    beforeSnapshot,
    beforeSnapshotSha256,
  };
}

export function digestBindings(bindings: readonly SandyBindingRow[]): string {
  return sha256(stableJson(bindings));
}

export function digestResults(results: readonly SandyResultRow[]): string {
  return sha256(stableJson(results));
}

export function assertExpectedSnapshot(
  read: SandyCorrectionRead,
  expected: {
    sourceStatus: "open";
    bindingCount: number;
    resultCount: number;
    bindingDigest: string;
    resultDigest: string;
    sourceIdentitySha256: string;
    beforeSnapshotSha256: string;
  },
  options: { allowVolatileIdentity?: boolean } = {},
): void {
  if (read.sourceWork.status !== expected.sourceStatus) {
    throw new Error(`source Work status mismatch: expected ${expected.sourceStatus}`);
  }
  if (read.sourceBindingCount !== expected.bindingCount) {
    throw new Error(`source binding count mismatch: expected ${expected.bindingCount}, observed ${read.sourceBindingCount}`);
  }
  if (read.sourceResultCount !== expected.resultCount) {
    throw new Error(`source result count mismatch: expected ${expected.resultCount}, observed ${read.sourceResultCount}`);
  }
  if (read.bindingDigest !== expected.bindingDigest) {
    throw new Error("source binding digest mismatch; refusing correction");
  }
  if (read.resultDigest !== expected.resultDigest) {
    throw new Error("source result digest mismatch; refusing correction");
  }
  if (!options.allowVolatileIdentity && read.identity.sha256 !== expected.sourceIdentitySha256) {
    throw new Error("source database identity mismatch; refusing correction");
  }
  if (read.beforeSnapshotSha256 !== expected.beforeSnapshotSha256) {
    throw new Error("source snapshot mismatch; refusing correction");
  }
}

export function assertTargetRows(read: SandyCorrectionRead): void {
  const current = read.bindings.filter((binding) => binding.isCurrent === 1);
  const allTurns = new Set([
    ...read.target.monitoringTurnIds,
    ...read.target.captureTurnIds,
  ]);
  if (new Set(read.target.monitoringTurnIds).size !== 2 || new Set(read.target.captureTurnIds).size !== 2) {
    throw new Error("correction requires two distinct monitoring and capture Turns");
  }
  if ([...allTurns].some((turnId) => !current.some((binding) => binding.turnId === turnId))) {
    throw new Error("each correction Turn must have a current binding");
  }
  if (current.length !== 4 || current.some((binding) => binding.workId !== read.target.sourceWorkId)) {
    throw new Error("source Work must have exactly the four audited current bindings");
  }
  if (read.results.some((result) => !allTurns.has(result.originTurnId))) {
    throw new Error("source Work contains a result from an unaudited Turn");
  }
  for (const turnId of allTurns) {
    const count = read.results.filter((result) => result.originTurnId === turnId).length;
    if (count === 0) throw new Error(`audited Turn has no Work results: ${turnId}`);
  }
  for (const result of read.results) {
    if (result.toolStatus !== "completed") {
      throw new Error(`audited result tool call is not completed: ${result.toolCallId}`);
    }
    if (!result.toolResultSha256 || result.toolResultSha256.length !== 64) {
      throw new Error(`audited result lacks a canonical result hash: ${result.toolCallId}`);
    }
  }
  for (const turnId of read.target.captureTurnIds) {
    if (!read.turnMessages.some((message) => message.turnId === turnId && message.originalMessage.trim())) {
      throw new Error(`capture Turn lacks its original request: ${turnId}`);
    }
  }
}

export function assertCanonicalSandyRead(read: SandyCorrectionRead): void {
  if (read.sourceWork.originTurnId !== SANDY_MONITORING_TURN_IDS[0] ||
    read.sourceWork.scopeKind !== SANDY_SOURCE_SCOPE_KIND ||
    read.sourceWork.scopeRef !== SANDY_SOURCE_SCOPE_REF ||
    read.sourceWork.objective !== SANDY_SOURCE_OBJECTIVE) {
    throw new Error("source Work does not match the immutable Sandy recipe evidence");
  }
  if (read.sessionHeadWorkId !== read.target.sourceWorkId ||
    read.selectedToolJournalCount !== SANDY_SELECTED_TOOL_JOURNAL_COUNT ||
    read.selectedToolJournalDigest.length !== 64) {
    throw new Error("source session head or selected raw tool journal does not match the immutable Sandy recipe");
  }
  if (!read.sourcePlan || read.sourcePlan.planRevisionId !== SANDY_SOURCE_PLAN_REVISION_ID ||
    read.sourcePlan.revision !== SANDY_SOURCE_PLAN_REVISION ||
    read.sourcePlan.objective !== SANDY_SOURCE_OBJECTIVE ||
    read.sourcePlan.originTurnId !== SANDY_MONITORING_TURN_IDS[0] ||
    read.sourcePlan.actions.length !== SANDY_SOURCE_ACTION_KEYS.length ||
    read.sourcePlan.actions.some((action, index) => action.actionKey !== SANDY_SOURCE_ACTION_KEYS[index]) ||
    stableJson(read.sourcePlan.checks) !== stableJson(SANDY_SOURCE_PLAN_CHECKS)) {
    throw new Error("source Work Plan does not match the immutable Sandy recipe");
  }
  if (!read.sourceCheckpoint || read.sourceCheckpoint.planRevisionId !== SANDY_SOURCE_PLAN_REVISION_ID ||
    read.sourceCheckpoint.resultSequence !== SANDY_SOURCE_CURRENT_RESULT_SEQUENCE ||
    read.sourceCheckpoint.originTurnId !== SANDY_MONITORING_TURN_IDS[0] ||
    read.sourceCheckpoint.actionStates.length !== SANDY_SOURCE_ACTION_KEYS.length ||
    read.sourceCheckpoint.actionStates.some((action, index) =>
      action.actionKey !== SANDY_SOURCE_ACTION_KEYS[index] ||
      action.status !== SANDY_SOURCE_CURRENT_ACTION_STATUSES[index])) {
    throw new Error("source Work current checkpoint does not match the immutable Sandy recipe");
  }
  if (read.resultCountByTurn[SANDY_MONITORING_TURN_IDS[0]] !== SANDY_EXPECTED_RESULT_COUNTS[SANDY_MONITORING_TURN_IDS[0]] ||
    read.resultCountByTurn[SANDY_MONITORING_TURN_IDS[1]] !== SANDY_EXPECTED_RESULT_COUNTS[SANDY_MONITORING_TURN_IDS[1]] ||
    read.resultCountByTurn[SANDY_CAPTURE_TURN_IDS[0]] !== SANDY_EXPECTED_RESULT_COUNTS[SANDY_CAPTURE_TURN_IDS[0]] ||
    read.resultCountByTurn[SANDY_CAPTURE_TURN_IDS[1]] !== SANDY_EXPECTED_RESULT_COUNTS[SANDY_CAPTURE_TURN_IDS[1]]) {
    throw new Error("per-Turn result counts do not match the immutable Sandy recipe");
  }
  const captureRequest = read.turnMessages.find((message) => message.turnId === SANDY_CAPTURE_TURN_IDS[0]);
  if (!captureRequest || captureRequest.originalMessage !== SANDY_CAPTURE_OBJECTIVE) {
    throw new Error("first capture objective does not match the immutable Sandy request");
  }
}

function assertTarget(input: SandyCorrectionTarget): void {
  if (!input.dbPath || !input.sessionId || !input.sourceWorkId) {
    throw new Error("correction requires dbPath, sessionId, and sourceWorkId");
  }
  const turnIds = [...input.monitoringTurnIds, ...input.captureTurnIds];
  if (turnIds.length !== 4 || turnIds.some((turnId) => !turnId)) {
    throw new Error("correction requires exactly four non-empty Turn IDs");
  }
  if (new Set(turnIds).size !== turnIds.length) {
    throw new Error("correction Turn IDs must be unique");
  }
}

function assertRequiredTables(db: Database): void {
  for (const table of [
    "btcc_guided_works",
    "btcc_guided_turn_work_bindings",
    "btcc_guided_work_results",
  ]) {
    const row = db.query<{ present: number }, [string]>(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table);
    if (!row) throw new Error(`required correction table is missing: ${table}`);
  }
}

function readWork(db: Database, workId: string): SandyWorkRow | null {
  const row = db.query<WorkSqlRow, [string]>(`
    SELECT work_id, session_id, scope_kind, scope_ref, origin_turn_id,
      origin_message_id, objective, status, current_plan_revision_id,
      created_at, updated_at
    FROM btcc_guided_works WHERE work_id = ?
  `).get(workId);
  return row ? mapWork(row) : null;
}

function readBindings(db: Database, sessionId: string, workId: string): SandyBindingRow[] {
  const rows = db.query<BindingSqlRow, [string, string]>(`
    SELECT binding_revision_id, turn_id, session_id, work_id, revision,
      is_current, bound_at
    FROM btcc_guided_turn_work_bindings
    WHERE session_id = ? AND work_id = ?
    ORDER BY bound_at, turn_id, revision
  `).all(sessionId, workId);
  return rows.map((row) => ({
    bindingRevisionId: row.binding_revision_id,
    turnId: row.turn_id,
    sessionId: row.session_id,
    workId: row.work_id,
    revision: row.revision,
    isCurrent: row.is_current,
    boundAt: row.bound_at,
  }));
}

function readResults(db: Database, workId: string): SandyResultRow[] {
  const hasToolCalls = hasTable(db, "btcc_guided_tool_calls");
  const hasResultHash = hasToolCalls && hasColumn(db, "btcc_guided_tool_calls", "result_sha256");
  const rows = db.query<ResultSqlRow, [string]>(hasToolCalls ? `
    SELECT result_ref, work_id, sequence, tool_call_id, origin_turn_id, attached_at,
      calls.status AS tool_status, ${hasResultHash ? "calls.result_sha256" : "NULL"} AS tool_result_sha256
    FROM btcc_guided_work_results results
    LEFT JOIN btcc_guided_tool_calls calls ON calls.call_id = results.tool_call_id
    WHERE results.work_id = ?
    ORDER BY sequence
  ` : `
    SELECT result_ref, work_id, sequence, tool_call_id, origin_turn_id, attached_at,
      NULL AS tool_status, NULL AS tool_result_sha256
    FROM btcc_guided_work_results WHERE work_id = ?
    ORDER BY sequence
  `).all(workId);
  return rows.map((row) => ({
    resultRef: row.result_ref,
    workId: row.work_id,
    sequence: row.sequence,
    toolCallId: row.tool_call_id,
    originTurnId: row.origin_turn_id,
    attachedAt: row.attached_at,
    ...(hasToolCalls ? { toolStatus: row.tool_status, toolResultSha256: row.tool_result_sha256 } : {}),
  }));
}

function readTurnMessages(db: Database, turnIds: readonly string[]): SandyTurnMessage[] {
  if (!hasTable(db, "btcc_turns")) return [];
  const rows = db.query<TurnSqlRow, string[]>(`
    SELECT turn_id, original_message_id, original_message
    FROM btcc_turns WHERE turn_id IN (${turnIds.map(() => "?").join(",")})
  `).all(...turnIds);
  return rows
    .filter((row): row is TurnSqlRow & { original_message_id: string; original_message: string } =>
      Boolean(row.original_message_id && row.original_message),
    )
    .map((row) => ({
      turnId: row.turn_id,
      originalMessageId: row.original_message_id,
      originalMessage: row.original_message,
    }))
    .sort((left, right) => turnIds.indexOf(left.turnId) - turnIds.indexOf(right.turnId));
}

function readSessionHead(db: Database, sessionId: string): string | null {
  if (!hasTable(db, "btcc_guided_work_session_heads")) return null;
  const row = db.query<{ work_id: string }, [string]>(`
    SELECT work_id FROM btcc_guided_work_session_heads WHERE session_id = ?
  `).get(sessionId);
  return row?.work_id ?? null;
}

function readPlan(db: Database, work: SandyWorkRow): SandyPlanSnapshot | null {
  if (!work.currentPlanRevisionId || !hasTable(db, "btcc_guided_work_plan_revisions")) return null;
  const row = db.query<{
    plan_revision_id: string;
    revision: number;
    objective: string;
    actions_json: string;
    checks_json: string;
    origin_turn_id: string;
  }, [string, string]>(`SELECT plan_revision_id, revision, objective, actions_json,
    checks_json, origin_turn_id FROM btcc_guided_work_plan_revisions
    WHERE plan_revision_id = ? AND work_id = ?`).get(work.currentPlanRevisionId, work.workId);
  if (!row) return null;
  try {
    return {
      planRevisionId: row.plan_revision_id,
      revision: row.revision,
      objective: row.objective,
      actions: JSON.parse(row.actions_json) as SandyPlanSnapshot["actions"],
      checks: JSON.parse(row.checks_json) as string[],
      originTurnId: row.origin_turn_id,
    };
  } catch {
    throw new Error(`source Work plan JSON is invalid: ${work.workId}`);
  }
}

function readCheckpoint(db: Database, work: SandyWorkRow): SandyCheckpointSnapshot | null {
  if (!hasTable(db, "btcc_guided_work_checkpoint_revisions")) return null;
  const row = db.query<{
    checkpoint_revision_id: string;
    revision: number;
    plan_revision_id: string;
    stage: string;
    public_summary: string;
    next_step: string;
    action_states_json: string;
    result_sequence: number;
    origin_turn_id: string;
  }, [string]>(`SELECT checkpoint_revision_id, revision, plan_revision_id, stage,
    public_summary, next_step, action_states_json, result_sequence, origin_turn_id
    FROM btcc_guided_work_checkpoint_revisions
    WHERE work_id = ? ORDER BY revision DESC LIMIT 1`).get(work.workId);
  if (!row) return null;
  try {
    return {
      checkpointRevisionId: row.checkpoint_revision_id,
      revision: row.revision,
      planRevisionId: row.plan_revision_id,
      stage: row.stage,
      publicSummary: row.public_summary,
      nextStep: row.next_step,
      actionStates: JSON.parse(row.action_states_json) as SandyCheckpointSnapshot["actionStates"],
      resultSequence: row.result_sequence,
      originTurnId: row.origin_turn_id,
    };
  } catch {
    throw new Error(`source Work checkpoint JSON is invalid: ${work.workId}`);
  }
}

function readSelectedToolJournalCount(db: Database, input: SandyCorrectionTarget): number {
  if (!hasTable(db, "btcc_guided_tool_calls")) return 0;
  const turnIds = [...input.monitoringTurnIds, ...input.captureTurnIds];
  return Number(db.query<{ count: number }, string[]>(`
    SELECT COUNT(*) AS count FROM btcc_guided_tool_calls
    WHERE turn_id IN (${turnIds.map(() => "?").join(",")})
  `).get(...turnIds)?.count ?? 0);
}

function assertSelectedToolJournalRows(db: Database, input: SandyCorrectionTarget): void {
  if (!hasTable(db, "btcc_guided_tool_calls")) return;
  const turnIds = [...input.monitoringTurnIds, ...input.captureTurnIds];
  const rows = db.query<{ status: string; result_sha256: string | null }, string[]>(`SELECT status,
    ${hasColumn(db, "btcc_guided_tool_calls", "result_sha256") ? "result_sha256" : "NULL"} AS result_sha256
    FROM btcc_guided_tool_calls WHERE turn_id IN (${turnIds.map(() => "?").join(",")})`).all(...turnIds);
  if (rows.some((row) => row.status !== "completed" || !row.result_sha256 || row.result_sha256.length !== 64)) {
    throw new Error("selected raw tool journal contains a non-canonical receipt");
  }
}

export function digestSelectedToolJournal(db: Database, input: SandyCorrectionTarget): string {
  if (!hasTable(db, "btcc_guided_tool_calls")) return sha256("missing-tool-journal");
  const turnIds = [...input.monitoringTurnIds, ...input.captureTurnIds];
  const rows = db.query<{
    call_id: string;
    turn_id: string;
    status: string;
    result_sha256: string | null;
  }, string[]>(`SELECT call_id, turn_id, status,
    ${hasColumn(db, "btcc_guided_tool_calls", "result_sha256") ? "result_sha256" : "NULL"} AS result_sha256
    FROM btcc_guided_tool_calls WHERE turn_id IN (${turnIds.map(() => "?").join(",")})
    ORDER BY call_id`).all(...turnIds);
  return sha256(stableJson(rows));
}

function mapWork(row: WorkSqlRow): SandyWorkRow {
  return {
    workId: row.work_id,
    sessionId: row.session_id,
    scopeKind: row.scope_kind,
    scopeRef: row.scope_ref,
    originTurnId: row.origin_turn_id,
    originMessageId: row.origin_message_id,
    objective: row.objective,
    status: row.status,
    currentPlanRevisionId: row.current_plan_revision_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
