import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type {
  BenchmarkLedgerObservation,
  BenchmarkLedgerRoute,
} from "./contracts.ts";

export function openBenchmarkAppDatabase(dataRoot: string): Database | null {
  for (const path of [
    join(dataRoot, "app-server", "butler-client.sqlite"),
    join(dataRoot, "butler-client.sqlite"),
  ]) {
    if (existsSync(path)) return new Database(path, { readonly: true });
  }
  return null;
}

export function readLedgerObservation(
  db: Database | null,
  turnId: string,
  expectedRoute: BenchmarkLedgerRoute,
): BenchmarkLedgerObservation {
  const none = emptyLedger(expectedRoute);
  if (!db || !turnId) return none;
  const guided = readGuidedWork(db, turnId, expectedRoute);
  if (guided) return guided;
  return readLegacyProgram(db, turnId, expectedRoute) ?? none;
}

function readGuidedWork(
  db: Database,
  turnId: string,
  expectedRoute: BenchmarkLedgerRoute,
): BenchmarkLedgerObservation | null {
  if (!tableExists(db, "btcc_guided_turn_work_bindings")) return null;
  const work = db.query<{
    scope_kind: "project" | "session";
    status: string;
    work_id: string;
  }, [string]>(`
    SELECT work.work_id, work.scope_kind, work.status
    FROM btcc_guided_turn_work_bindings binding
    JOIN btcc_guided_works work ON work.work_id = binding.work_id
    WHERE binding.turn_id = ? AND binding.is_current = 1
    LIMIT 1
  `).get(turnId);
  if (!work) return null;
  const resultRecords = countWhere(
    db,
    "btcc_guided_work_results",
    "work_id",
    work.work_id,
  );
  const checkpointRecords = countWhere(
    db,
    "btcc_guided_work_checkpoint_revisions",
    "work_id",
    work.work_id,
  );
  const reviewRecords = countWhere(
    db,
    "btcc_guided_work_review_revisions",
    "work_id",
    work.work_id,
  );
  const projectLedgerEffects = work.scope_kind === "project"
    ? countProjectLedgerEffects(db, turnId)
    : 0;
  return {
    expectedRoute,
    observedRoute: work.scope_kind === "project" ? "project" : "work",
    source: "guided_work",
    scopeKind: work.scope_kind,
    workId: work.work_id,
    status: work.status,
    workRecords: 1,
    taskRecords: 0,
    resultRecords,
    checkpointRecords,
    reviewRecords,
    mutationRecords: countWhere(
      db,
      "btcc_guided_work_mutations",
      "work_id",
      work.work_id,
    ),
    projectLedgerEffects,
    closeoutObserved:
      work.status === "completed" &&
      checkpointRecords > 0 &&
      reviewRecords > 0 &&
      (work.scope_kind !== "project" || projectLedgerEffects > 0),
    evidenceRefs: [
      "btcc_guided_turn_work_bindings",
      "btcc_guided_works",
      "btcc_guided_work_results",
      "btcc_guided_work_checkpoint_revisions",
      "btcc_guided_work_review_revisions",
      "btcc_guided_work_mutations",
      ...(work.scope_kind === "project" ? ["btcc_guided_tool_calls"] : []),
    ],
  };
}

function readLegacyProgram(
  db: Database,
  turnId: string,
  expectedRoute: BenchmarkLedgerRoute,
): BenchmarkLedgerObservation | null {
  if (!tableExists(db, "btcc_programs") || !tableExists(db, "btcc_turns")) return null;
  const session = db.query<{ session_id: string }, [string]>(
    "SELECT session_id FROM btcc_turns WHERE turn_id = ? LIMIT 1",
  ).get(turnId)?.session_id;
  if (!session) return null;
  const program = db.query<{
    frontier: string;
    program_id: string;
    scope_kind: string;
  }, [string]>(`
    SELECT program_id, scope_kind, frontier
    FROM btcc_programs
    WHERE session_id = ?
    ORDER BY manifest_revision DESC
    LIMIT 1
  `).get(session);
  if (!program) return null;
  const workRecords = countWhere(db, "btcc_work_items", "program_id", program.program_id);
  const taskRecords = countWhere(db, "btcc_tasks", "program_id", program.program_id);
  const resultRecords = tableExists(db, "btcc_tasks")
    ? countQuery(
      db,
      "SELECT COUNT(*) AS count FROM btcc_tasks WHERE program_id = ? AND result_ref IS NOT NULL",
      program.program_id,
    )
    : 0;
  const scopeKind = program.scope_kind === "project" ? "project" : "session";
  const mutationRecords = countWhere(
    db,
    "btcc_ledger_mutations",
    "program_id",
    program.program_id,
  );
  return {
    expectedRoute,
    observedRoute: scopeKind === "project"
      ? "project"
      : workRecords > 0 ? "work" : "none",
    source: "legacy_program",
    scopeKind,
    workId: null,
    status: program.frontier,
    workRecords,
    taskRecords,
    resultRecords,
    checkpointRecords: countWhere(db, "btcc_checkpoints", "turn_id", turnId),
    reviewRecords: 0,
    mutationRecords,
    projectLedgerEffects: scopeKind === "project" ? mutationRecords : 0,
    closeoutObserved:
      /complete|closed|reported/iu.test(program.frontier) &&
      workRecords > 0 &&
      resultRecords > 0,
    evidenceRefs: [
      "btcc_turns",
      "btcc_programs",
      "btcc_work_items",
      "btcc_tasks",
      "btcc_checkpoints",
      "btcc_ledger_mutations",
    ].filter((table) => tableExists(db, table)),
  };
}

function emptyLedger(expectedRoute: BenchmarkLedgerRoute): BenchmarkLedgerObservation {
  return {
    expectedRoute,
    observedRoute: "none",
    source: "none",
    scopeKind: null,
    workId: null,
    status: null,
    workRecords: 0,
    taskRecords: 0,
    resultRecords: 0,
    checkpointRecords: 0,
    reviewRecords: 0,
    mutationRecords: 0,
    projectLedgerEffects: 0,
    closeoutObserved: false,
    evidenceRefs: [],
  };
}

export function tableExists(db: Database, table: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
  `).get(table));
}

function countWhere(
  db: Database,
  table: string,
  column: string,
  value: string,
): number {
  if (!tableExists(db, table)) return 0;
  return countQuery(
    db,
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
    value,
  );
}

function countQuery(db: Database, query: string, value: string): number {
  return db.query<{ count: number }, [string]>(query).get(value)?.count ?? 0;
}

function countProjectLedgerEffects(db: Database, turnId: string): number {
  if (
    !tableExists(db, "btcc_guided_tool_calls") ||
    !tableExists(db, "btcc_guided_effects")
  ) return 0;
  return db.query<{ count: number }, [string]>(`
    SELECT COUNT(*) AS count
    FROM btcc_guided_tool_calls call
    JOIN btcc_guided_effects effect
      ON effect.receipt_id = json_extract(
        call.result_json,
        '$.effect_receipt.receipt_id'
      )
    WHERE call.turn_id = ?
      AND call.tool_name IN (
        'project_ledger_create',
        'project_ledger_update',
        'project_ledger_work_update',
        'project_ledger_work_complete',
        'project_ledger_task_update',
        'project_ledger_task_complete',
        'project_ledger_attempt_succeed',
        'project_ledger_attempt_fail'
      )
      AND call.status = 'completed'
      AND effect.status = 'applied'
  `).get(turnId)?.count ?? 0;
}
