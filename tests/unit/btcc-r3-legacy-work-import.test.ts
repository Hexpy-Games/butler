import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDurableWorkService } from
  "../../packages/butler-agent/src/agent/btcc/durable-work/index.ts";
import { SqliteGuidedWorkStore } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { seedManagedProgramForStop } from
  "./support/btcc-stopped-work-fixture.ts";

test("open R2 Session Work imports once as concise R3 Work across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-legacy-import-"));
  const dbPath = join(root, "butler.sqlite");
  let db: Database | null = new Database(dbPath);
  const scope = {
    turnId: "turn-r3-import",
    sessionId: "session-fixture",
  };
  let workId: string;
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    seedManagedProgramForStop(db);
    db.query(`
      UPDATE btcc_turns SET goal_contract_ref = (
        SELECT goal_contract_ref FROM btcc_programs
        WHERE program_id = 'program-session'
      ) WHERE turn_id = 'turn-user-stopped'
    `).run();
    insertTurn(db, scope.turnId, scope.sessionId, "이전 작업을 이어서 진행해 주세요.");
    const service = createDurableWorkService(new SqliteGuidedWorkStore(db));

    const imported = await service.importOpenLegacyWork(scope);
    expect(imported).toMatchObject({
      sourceProgramId: "program-session",
      imported: true,
      work: {
        status: "open",
        scope: { kind: "session", sessionId: scope.sessionId },
        origin: {
          turnId: "turn-user-stopped",
          messageId: "message-user-stopped",
        },
        objective: "Complete four tasks",
        currentPlan: {
          revision: 1,
          actions: [
            {
              actionKey: "task-a",
              description: "Task A: Complete task A.",
              dependencyKeys: [],
            },
            {
              actionKey: "task-b",
              dependencyKeys: ["task-a"],
            },
            {
              actionKey: "task-c",
              dependencyKeys: ["task-b"],
            },
            {
              actionKey: "task-d",
              dependencyKeys: ["task-c"],
            },
          ],
          checks: expect.arrayContaining([
            "Task A is complete.",
            "Task D is complete.",
          ]),
        },
        latestCheckpoint: {
          stage: "execution",
          publicSummary:
            "Imported prior progress: 2 of 4 planned actions have recorded accepted results.",
          nextStep: "Task C: Complete task C.",
        },
        resultRefs: [],
      },
    });
    expect(imported?.work.latestPlanReview).toBeUndefined();
    expect(imported?.work.latestResultReview).toBeUndefined();
    expect(imported?.work.currentPlan?.actions.every((action) => !action.effect))
      .toBe(true);
    expect((await service.loadContext(scope))?.originalRequest.content)
      .toBe("Start the four-task Program");
    expect(await service.boundWorkForTurn(scope.turnId)).toBeNull();
    workId = imported?.work.workId ?? "";
    db.close();
    db = null;

    db = new Database(dbPath);
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const resumed = createDurableWorkService(new SqliteGuidedWorkStore(db));
    expect(await resumed.importOpenLegacyWork(scope)).toMatchObject({
      sourceProgramId: "program-session",
      imported: false,
      work: { workId },
    });
    expect(count(db, "btcc_guided_works")).toBe(1);
    expect(count(db, "btcc_guided_work_plan_revisions")).toBe(1);
    expect(count(db, "btcc_guided_work_checkpoint_revisions")).toBe(1);
    expect(count(db, "btcc_guided_work_legacy_imports")).toBe(1);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite importer ignores local Project rows and closed R2 Programs", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    seedManagedProgramForStop(db);
    db.query(`
      UPDATE btcc_programs SET scope_kind = 'project', scope_id = 'project-a'
      WHERE program_id = 'program-session'
    `).run();
    insertTurn(db, "turn-project-import", "session-fixture", "프로젝트 작업을 이어갑니다.");
    const service = createDurableWorkService(new SqliteGuidedWorkStore(db));
    expect(await service.importOpenLegacyWork({
      turnId: "turn-project-import",
      sessionId: "session-fixture",
      projectRef: "project-a",
    })).toBeNull();
    expect(count(db, "btcc_guided_works")).toBe(0);

    db.query(`
      UPDATE btcc_programs
      SET scope_kind = 'session', scope_id = 'session-fixture', frontier = 'closed'
      WHERE program_id = 'program-session'
    `).run();
    expect(await service.importOpenLegacyWork({
      turnId: "turn-project-import",
      sessionId: "session-fixture",
    })).toBeNull();
    expect(count(db, "btcc_guided_works")).toBe(0);
  } finally {
    db.close();
  }
});

test("fresh R3 storage without legacy Work tables returns no import", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    db.exec(`
      DROP TABLE btcc_ledger_mutations;
      DROP TABLE btcc_tasks;
      DROP TABLE btcc_work_items;
      DROP TABLE btcc_programs;
      DROP TABLE btcc_records;
    `);
    insertTurn(db, "turn-fresh-r3", "session-fresh-r3", "새 작업입니다.");
    const service = createDurableWorkService(new SqliteGuidedWorkStore(db));
    expect(await service.importOpenLegacyWork({
      turnId: "turn-fresh-r3",
      sessionId: "session-fresh-r3",
    })).toBeNull();
    expect(count(db, "btcc_guided_works")).toBe(0);
  } finally {
    db.close();
  }
});

function insertTurn(
  db: Database,
  turnId: string,
  sessionId: string,
  message: string,
): void {
  db.query(`
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, continuation_snapshot_json, semantic_state,
      revision, execution_fence
    ) VALUES (?, ?, ?, ?, ?, ?, 'snapshot', '{}', '{}', '[]', 'admitted', 1, 1)
  `).run(
    turnId,
    sessionId,
    `inbox-${turnId}`,
    `trigger-${turnId}`,
    `message-${turnId}`,
    message,
  );
}

function count(db: Database, table: string): number {
  return db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM ${table}
  `).get()?.count ?? 0;
}
