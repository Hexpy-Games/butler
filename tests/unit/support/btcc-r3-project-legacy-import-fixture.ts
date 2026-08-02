import type { Database } from "bun:sqlite";
import { contentRef, digest, stableJson } from
  "../../../packages/butler-agent/src/agent/btcc/identity/index.ts";

type ProjectCore = {
  createRecord(project: string, options: Record<string, unknown>): unknown;
};

export async function publishReviewedProgram(
  core: ProjectCore,
  projectRoot: string,
) {
  return publishProgram(core, projectRoot, "program-fixture", true);
}

export async function publishBoundProgram(
  core: ProjectCore,
  projectRoot: string,
  programId: string,
  _turnId: string,
) {
  return publishProgram(core, projectRoot, programId, false);
}

function publishProgram(
  core: ProjectCore,
  projectRoot: string,
  programId: string,
  reviewed: boolean,
) {
  const goalBody = {
    originalMessageId: `message-${programId}`,
    request: "Produce the fixture result",
    intendedResult: "Produce the fixture result",
    acceptanceIntent: "The canonical Spec and result are satisfied",
  };
  const goalContractRef = contentRef("goal-contract", goalBody);
  const logicalId = `ledger-record:${goalContractRef.id}`;
  const logicalBody = {
    ref: { id: logicalId, sha256: digest(stableJson(goalBody)) },
    sourceId: goalContractRef.id,
    record: goalBody,
  };
  core.createRecord(projectRoot, {
    kind: "reference",
    id: logicalId,
    title: `Legacy Goal ${programId}`,
    status: "active",
    body: stableJson(logicalBody),
  });
  const work = {
    ref: contentRef("work", { programId, logicalId: "result" }),
    workLogicalId: "result",
    outcome: "The requested result is complete.",
  };
  const task = {
    ref: contentRef("task", { programId, logicalId: "produce-result" }),
    taskLogicalId: "produce-result",
    displayTitle: "결과 생성 및 검증",
    intendedOutcome: "Produce and verify the requested result.",
    dependencyTaskRefs: [],
    criterionRefs: [],
  };
  const criterion = {
    ref: contentRef("criterion", { programId, statement: "fixture" }),
    statement: "The requested result satisfies the original intent.",
  };
  task.criterionRefs.push(criterion.ref as never);
  const program = {
    programId,
    manifestRevision: reviewed ? 2 : 1,
    planningState: reviewed ? "reviewed" : "unplanned",
    frontier: "implementation_open",
    goalContractRef,
    ...(reviewed
      ? {
          plan: { strategy: "Produce one reviewed result." },
          works: [{ status: "active", work }],
          tasks: [{ status: "planned", task }],
          criteria: [criterion],
        }
      : { works: [], tasks: [], criteria: [] }),
  };
  core.createRecord(projectRoot, {
    kind: "reference",
    id: `BTCC-PROGRAM-${programId}`,
    title: `Legacy Program ${programId}`,
    status: "active",
    body: stableJson(program),
  });
  return program;
}

export function seedProjectLocator(
  db: Database,
  programId: string,
  sessionId: string,
  messageId: string,
): void {
  installLegacyProjectLocatorSchema(db);
  insertTurn(db, {
    turnId: `turn-r2-${programId}`,
    sessionId,
    messageId,
    message: "Produce the fixture result from the canonical request.",
    programId,
  });
  db.query(`
    INSERT INTO btcc_project_program_projections (
      program_id, project_ref, ledger_id, manifest_revision
    ) VALUES (?, 'stale-local-project-ref', 'stale-local-ledger', 999)
  `).run(programId);
}

export function seedStaleLocalProjectProgram(
  db: Database,
  programId: string,
  goalContractRef: string,
): void {
  installLegacyProjectLocatorSchema(db);
  db.query(`
    INSERT INTO btcc_programs (
      program_id, ledger_id, scope_kind, scope_id, session_id,
      goal_contract_ref, authority_ref, frontier, manifest_revision
    ) VALUES (?, 'stale-local-ledger', 'project', 'wrong-project', 'wrong-session',
      ?, 'wrong-authority', 'closed', 999)
  `).run(programId, goalContractRef);
  db.query(`
    INSERT OR REPLACE INTO btcc_records (record_id, kind, sha256, content_json)
    VALUES (?, 'goal_contract', 'wrong-sha', ?)
  `).run(goalContractRef, stableJson({
    request: "LOCAL PROJECT CONTENT MUST NEVER BE IMPORTED",
  }));
}

export function insertTurn(db: Database, input: {
  turnId: string;
  sessionId: string;
  messageId: string;
  message: string;
  programId?: string;
}): void {
  installLegacyProjectLocatorSchema(db);
  db.query(`
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, managed_state_json, semantic_state, revision,
      execution_fence, route
    ) VALUES (?, ?, ?, ?, ?, ?, 'snapshot', '{}', '{}', ?, 'admitted',
      1, 1, ?)
  `).run(
    input.turnId,
    input.sessionId,
    `inbox-${input.turnId}`,
    `trigger-${input.turnId}`,
    input.messageId,
    input.message,
    input.programId ? stableJson({ programId: input.programId }) : null,
    input.programId ? "managed" : null,
  );
}

function installLegacyProjectLocatorSchema(db: Database): void {
  if (!hasColumn(db, "btcc_turns", "managed_state_json")) {
    db.exec("ALTER TABLE btcc_turns ADD COLUMN managed_state_json TEXT");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS btcc_project_program_projections (
      program_id TEXT PRIMARY KEY,
      project_ref TEXT NOT NULL,
      ledger_id TEXT NOT NULL,
      manifest_revision INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS btcc_programs (
      program_id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      goal_contract_ref TEXT NOT NULL,
      authority_ref TEXT NOT NULL,
      frontier TEXT NOT NULL,
      manifest_revision INTEGER NOT NULL
    );
  `);
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
    .some((candidate) => candidate.name === column);
}

export function rowCount(db: Database, table: string): number {
  return db.query<{ count: number }, []>(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).get()?.count ?? 0;
}
