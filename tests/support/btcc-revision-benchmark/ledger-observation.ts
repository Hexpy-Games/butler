import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";
import type {
  BenchmarkLedgerObservation,
  BenchmarkLedgerRoute,
  BtccRevision,
} from "./contracts.ts";
import {
  projectLedgerWorkIdFromEffectTarget,
  readCanonicalProjectLedgerWorks,
} from
  "../project-ledger-work-observation.ts";

export function openBenchmarkAppDatabase(dataRoot: string): Database | null {
  for (const path of [
    join(dataRoot, "app-server", "butler-client.sqlite"),
    join(dataRoot, "butler-client.sqlite"),
  ]) {
    if (existsSync(path)) return new Database(path, { readonly: true });
  }
  return null;
}

export function resolveBenchmarkLedgerProjectId(input: {
  appProjectId?: string;
  dataRoot: string;
  db: Database | null;
  revision: BtccRevision;
  workspaceRoot: string;
}): string | undefined {
  if (input.revision === "r3") {
    return safeLedgerProjectId(input.appProjectId);
  }
  const row = input.db && input.appProjectId && tableExists(input.db, "projects")
    ? input.db.query<{
        display_name: string;
        id: string;
        safe_path_label: string;
        workspace_label: string;
      }, [string]>(`
        SELECT id, display_name, workspace_label, safe_path_label
        FROM projects WHERE archived = 0 AND id = ? LIMIT 1
      `).get(input.appProjectId)
    : null;
  const candidates = uniqueSafeLedgerProjectIds([
    readJsonString(join(input.workspaceRoot, "project.json"), "id"),
    readJsonString(join(input.workspaceRoot, "package.json"), "name"),
    basename(input.workspaceRoot),
    row?.safe_path_label,
    row?.workspace_label,
    row?.display_name,
    row?.id,
    input.appProjectId,
  ]);
  const initialized = candidates.find((candidate) => {
    const root = join(input.dataRoot, "project-ledger", "projects", candidate);
    return existsSync(join(root, "project.json")) &&
      existsSync(join(root, "ledger.jsonl"));
  });
  return initialized ?? candidates[0];
}

export function readLedgerObservation(
  db: Database | null,
  turnId: string,
  expectedRoute: BenchmarkLedgerRoute,
  dataRoot?: string,
  projectId?: string,
): BenchmarkLedgerObservation {
  const none = emptyLedger(expectedRoute);
  if (!db || !turnId) return none;
  const guided = readGuidedWork(
    db,
    turnId,
    expectedRoute,
    dataRoot,
    projectId,
  );
  if (guided) return guided;
  return readLegacyProgram(
    db,
    turnId,
    expectedRoute,
    dataRoot,
    projectId,
  ) ?? none;
}

function readGuidedWork(
  db: Database,
  turnId: string,
  expectedRoute: BenchmarkLedgerRoute,
  dataRoot?: string,
  projectId?: string,
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
    ? countProjectLedgerEffects(db, turnId, work.work_id)
    : 0;
  const projectLedgerWorks = work.scope_kind === "project" && dataRoot && projectId
    ? readCanonicalProjectLedgerWorks(dataRoot, projectId)
    : [];
  const effectWorkIds = work.scope_kind === "project"
    ? completedProjectLedgerWorkIds(db, turnId, work.work_id)
    : new Set<string>();
  const currentProjectLedgerWorks = projectLedgerWorks.filter((record) =>
    effectWorkIds.has(record.id),
  );
  const canonicalProjectLedgerCloseout = currentProjectLedgerWorks.some(
    (record) => record.status === "done",
  );
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
      resultRecords > 0 &&
      reviewRecords >= 2 &&
      (work.scope_kind !== "project" || canonicalProjectLedgerCloseout),
    evidenceRefs: [
      "btcc_guided_turn_work_bindings",
      "btcc_guided_works",
      "btcc_guided_work_results",
      "btcc_guided_work_checkpoint_revisions",
      "btcc_guided_work_review_revisions",
      "btcc_guided_work_mutations",
      ...(work.scope_kind === "project"
        ? [
          "btcc_guided_tool_calls",
          "btcc_guided_effects",
          ...currentProjectLedgerWorks.map((record) => record.ref),
        ]
        : []),
    ],
  };
}

function readLegacyProgram(
  db: Database,
  turnId: string,
  expectedRoute: BenchmarkLedgerRoute,
  dataRoot?: string,
  projectId?: string,
): BenchmarkLedgerObservation | null {
  if (
    !tableExists(db, "btcc_programs") ||
    !tableExists(db, "btcc_ledger_mutations")
  ) return null;
  const program = db.query<{
    frontier: string;
    program_id: string;
    scope_kind: string;
  }, [string]>(`
    SELECT program.program_id, program.scope_kind, program.frontier
    FROM btcc_ledger_mutations mutation
    JOIN btcc_programs program ON program.program_id = mutation.program_id
    WHERE mutation.turn_id = ?
    ORDER BY mutation.rowid DESC
    LIMIT 1
  `).get(turnId);
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
  const projectLedgerWorks = scopeKind === "project" && dataRoot && projectId
    ? readCanonicalProjectLedgerWorks(dataRoot, projectId)
    : [];
  const programWorkIds = scopeKind === "project"
    ? workIdsForProgram(db, program.program_id)
    : new Set<string>();
  const currentProjectLedgerWorks = projectLedgerWorks.filter((record) =>
    programWorkIds.has(record.id),
  );
  const canonicalProjectLedgerCloseout = currentProjectLedgerWorks.some(
    (record) => record.status === "done",
  );
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
      resultRecords > 0 &&
      (scopeKind !== "project" || canonicalProjectLedgerCloseout),
    evidenceRefs: [
      ...[
        "btcc_turns",
        "btcc_programs",
        "btcc_work_items",
        "btcc_tasks",
        "btcc_checkpoints",
        "btcc_ledger_mutations",
      ].filter((table) => tableExists(db, table)),
      ...currentProjectLedgerWorks.map((record) => record.ref),
    ],
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

function uniqueSafeLedgerProjectIds(
  values: Array<string | null | undefined>,
): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const normalized = safeLedgerProjectId(value);
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
}

function safeLedgerProjectId(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(normalized)
    ? normalized
    : undefined;
}

function readJsonString(path: string, key: string): string | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return typeof value[key] === "string" && value[key].trim()
      ? value[key].trim()
      : null;
  } catch {
    return null;
  }
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

function countProjectLedgerEffects(
  db: Database,
  turnId: string,
  workId: string,
): number {
  if (
    !tableExists(db, "btcc_guided_tool_calls") ||
    !tableExists(db, "btcc_guided_effects")
  ) return 0;
  return db.query<{ count: number }, [string, string]>(`
    SELECT COUNT(*) AS count
    FROM btcc_guided_tool_calls call
    JOIN btcc_guided_effects effect
      ON effect.receipt_id = json_extract(
        call.result_json,
        '$.effect_receipt.receipt_id'
      )
    WHERE call.turn_id = ?
      AND effect.work_id = ?
      AND effect.capability = call.tool_name
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
  `).get(turnId, workId)?.count ?? 0;
}

function completedProjectLedgerWorkIds(
  db: Database,
  turnId: string,
  workId: string,
): Set<string> {
  if (
    !tableExists(db, "btcc_guided_tool_calls") ||
    !tableExists(db, "btcc_guided_effects")
  ) return new Set();
  const rows = db.query<{ sanitized_target: string }, [string, string]>(`
    SELECT effect.sanitized_target
    FROM btcc_guided_tool_calls call
    JOIN btcc_guided_effects effect
      ON effect.receipt_id = json_extract(
        call.result_json,
        '$.effect_receipt.receipt_id'
      )
    WHERE call.turn_id = ?
      AND effect.work_id = ?
      AND call.tool_name = 'project_ledger_work_complete'
      AND effect.capability = 'project_ledger_work_complete'
      AND call.status = 'completed'
      AND effect.status = 'applied'
  `).all(turnId, workId);
  return new Set(rows.flatMap((row) => {
    const id = projectLedgerWorkIdFromEffectTarget(row.sanitized_target);
    return id ? [id] : [];
  }));
}

function workIdsForProgram(db: Database, programId: string): Set<string> {
  if (!tableExists(db, "btcc_work_items")) return new Set();
  return new Set(db.query<{ work_id: string }, [string]>(`
    SELECT work_id FROM btcc_work_items WHERE program_id = ?
  `).all(programId).map((row) => row.work_id));
}
