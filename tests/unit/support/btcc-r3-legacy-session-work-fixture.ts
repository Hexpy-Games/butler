import type { Database } from "bun:sqlite";

const SESSION_ID = "session-fixture";
const PROGRAM_ID = "program-session";
const ORIGIN_TURN_ID = "turn-user-stopped";
const ORIGIN_MESSAGE_ID = "message-user-stopped";
const GOAL_RECORD_ID = "goal-four-tasks";
const PLAN_RECORD_ID = "plan-four-tasks";
const WORK_RECORD_ID = "work-four-tasks";

export function seedLegacySessionWork(db: Database): void {
  createLegacyWorkTables(db);
  addLegacyTurnColumn(db, "goal_contract_ref", "TEXT");
  addLegacyTurnColumn(db, "managed_state_json", "TEXT");
  seedLegacyRecords(db);
  seedLegacyProgram(db);
  seedLegacyOriginTurn(db);
}

function createLegacyWorkTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS btcc_programs (
      program_id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      goal_contract_ref TEXT NOT NULL,
      accepted_plan_ref TEXT,
      frontier TEXT NOT NULL,
      manifest_revision INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS btcc_work_items (
      work_id TEXT PRIMARY KEY,
      program_id TEXT NOT NULL,
      work_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS btcc_tasks (
      task_id TEXT PRIMARY KEY,
      program_id TEXT NOT NULL,
      work_id TEXT NOT NULL,
      task_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS btcc_ledger_mutations (
      mutation_id TEXT PRIMARY KEY,
      program_id TEXT NOT NULL
    );
  `);
}

function seedLegacyRecords(db: Database): void {
  insertRecord(db, GOAL_RECORD_ID, "goal_contract", {
    originalMessageId: ORIGIN_MESSAGE_ID,
    request: "Complete four tasks",
    intendedResult: "All tasks complete",
    acceptanceIntent: "Every task is reviewed",
  });
  insertRecord(db, PLAN_RECORD_ID, "plan", {
    strategy: "Complete four dependent tasks in order.",
  });
  insertRecord(db, WORK_RECORD_ID, "work", {
    workLogicalId: "four-task-work",
    outcome: "All four reviewed tasks are complete.",
  });

  const taskIds = ["task-a", "task-b", "task-c", "task-d"];
  for (const [index, taskId] of taskIds.entries()) {
    const label = taskId.slice(-1).toUpperCase();
    const criterionId = `criterion-${taskId}`;
    insertRecord(db, criterionId, "criterion", {
      statement: `Task ${label} is complete.`,
    });
    insertRecord(db, taskId, "task", {
      ref: { id: taskId, sha256: `${taskId}-sha256` },
      taskLogicalId: taskId,
      displayTitle: `Task ${label}`,
      intendedOutcome: `Complete task ${label}.`,
      dependencyTaskRefs: index === 0
        ? []
        : [{ id: taskIds[index - 1], sha256: `${taskIds[index - 1]}-sha256` }],
      criterionRefs: [{ id: criterionId, sha256: `${criterionId}-sha256` }],
    });
  }
}

function seedLegacyProgram(db: Database): void {
  db.query(`
    INSERT INTO btcc_programs (
      program_id, scope_kind, scope_id, session_id, goal_contract_ref,
      accepted_plan_ref, frontier, manifest_revision
    ) VALUES (?, 'session', ?, ?, ?, ?, 'active', 2)
  `).run(
    PROGRAM_ID,
    SESSION_ID,
    SESSION_ID,
    GOAL_RECORD_ID,
    PLAN_RECORD_ID,
  );
  db.query(`
    INSERT INTO btcc_work_items (
      work_id, program_id, work_ref, status, is_active
    ) VALUES ('work-four', ?, ?, 'active', 1)
  `).run(PROGRAM_ID, WORK_RECORD_ID);

  const taskStates = [
    ["task-a", "accepted"],
    ["task-b", "accepted"],
    ["task-c", "selected"],
    ["task-d", "planned"],
  ] as const;
  for (const [taskId, status] of taskStates) {
    db.query(`
      INSERT INTO btcc_tasks (
        task_id, program_id, work_id, task_ref, status, is_active
      ) VALUES (?, ?, 'work-four', ?, ?, 1)
    `).run(taskId, PROGRAM_ID, taskId, status);
  }
  db.query(`
    INSERT INTO btcc_ledger_mutations (mutation_id, program_id)
    VALUES ('mutation-four-task-plan', ?)
  `).run(PROGRAM_ID);
}

function seedLegacyOriginTurn(db: Database): void {
  const values = [
    ORIGIN_TURN_ID,
    SESSION_ID,
    "inbox-user-stopped",
    "message:user-stopped",
    ORIGIN_MESSAGE_ID,
    "Start the four-task Program",
    "snapshot-user-stopped",
    JSON.stringify({ provider: "openai", model: "gpt-5.6-sol" }),
    "{}",
    GOAL_RECORD_ID,
    JSON.stringify({ programId: PROGRAM_ID, selectedTaskId: "task-c" }),
  ] as const;
  if (hasColumn(db, "btcc_turns", "continuation_snapshot_json")) {
    db.query(`
      INSERT INTO btcc_turns (
        turn_id, session_id, inbox_id, trigger_key, original_message_id,
        original_message, admission_snapshot_ref, model_selection_json,
        context_json, goal_contract_ref, managed_state_json,
        continuation_snapshot_json, semantic_state, route, revision,
        execution_fence, final_disposition
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'cancelled',
        'managed', 8, 1, 'cancelled')
    `).run(...values);
    return;
  }
  db.query(`
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, goal_contract_ref, managed_state_json, semantic_state,
      route, revision, execution_fence, final_disposition
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cancelled', 'managed',
      8, 1, 'cancelled')
  `).run(...values);
}

function insertRecord(
  db: Database,
  recordId: string,
  kind: string,
  content: unknown,
): void {
  db.query(`
    INSERT INTO btcc_records (record_id, kind, sha256, content_json)
    VALUES (?, ?, ?, ?)
  `).run(recordId, kind, `${recordId}-sha256`, JSON.stringify(content));
}

function addLegacyTurnColumn(
  db: Database,
  name: string,
  declaration: string,
): void {
  if (hasColumn(db, "btcc_turns", name)) return;
  db.exec(`ALTER TABLE btcc_turns ADD COLUMN ${name} ${declaration}`);
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
    .some((candidate) => candidate.name === column);
}
