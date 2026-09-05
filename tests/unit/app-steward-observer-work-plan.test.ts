import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDurableWorkService } from "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import { createProjectWorkStore } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { loadProjectLedgerCore } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-ledger-core.ts";
import { openBtccAuthorityStore } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/open-btcc-sqlite-stores.ts";
import { agentBtccStoragePaths } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/storage-ownership/index.ts";
import { SqliteProjectWorkResultRuntime } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/project-work-result-runtime.ts";
import { createSqliteProjectWorkRuntimeProjection } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/project-work-runtime-projection.ts";
import { projectStewardSession } from "../../packages/butler-agent/src/gateways/app/domain/sessions/steward-observer.ts";
import { sessionViewForStewardObserver } from "../../packages/butler-agent/src/gateways/app/domain/sessions/steward-observer-view.ts";

test("App observer reads the bound Project Work plan and updates capsule and modal together", async () => {
  const butlerData = realpathSync(mkdtempSync(join(tmpdir(), "steward-plan-")));
  const stores = openBtccAuthorityStore({ butlerData });
  const db = new Database(agentBtccStoragePaths(butlerData).agentBtccDbPath);
  try {
    const core = await loadProjectLedgerCore();
    const scope = {
      appProjectId: "app-project",
      ledgerProjectId: "ledger-project",
      ledgerRoot: join(butlerData, "project-ledger", "projects", "ledger-project"),
    };
    mkdirSync(scope.ledgerRoot, { recursive: true });
    writeFileSync(join(scope.ledgerRoot, "project.json"), JSON.stringify({
      schema: "project-ledger.project.v1", id: scope.ledgerProjectId, name: "Observer plan", status: "active",
    }));
    writeFileSync(join(scope.ledgerRoot, "ledger.jsonl"), "");
    core.writeIndex(scope.ledgerRoot);
    insertTurn(db, "turn", "steward");
    db.query("INSERT INTO btcc_session_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("relation", "parent", "parent-turn", "steward", "anchor", 1, "Project task", "2026-09-05T00:00:00.000Z");
    const resultRuntime = new SqliteProjectWorkResultRuntime(db);
    const service = createDurableWorkService(createProjectWorkStore({
      butlerData,
      scope,
      resultRuntime,
      runtimeProjection: createSqliteProjectWorkRuntimeProjection(db, resultRuntime),
    }));
    const turn = { turnId: "turn", sessionId: "steward", projectRef: scope.appProjectId };
    const work = await service.startWork({ ...turn, mutationCallId: "start", objective: "Implement the request" });
    await service.replacePlan({
      ...turn, mutationCallId: "plan", objective: work.objective,
      actions: [
        { actionKey: "implement", description: "Implement", dependencyKeys: [] },
        { actionKey: "review", description: "Review", dependencyKeys: ["implement"] },
        { actionKey: "report", description: "Report", dependencyKeys: ["review"] },
      ],
      checks: [],
    });
    await service.recordReview({
      ...turn, mutationCallId: "approve", subject: "plan", verdict: "accept",
      summary: "Plan matches the request", corrections: [],
    });
    const relation = stores.observer.relationsForParent("parent")[0]!;
    const initial = stores.observer.snapshot("steward")!;
    expect(projectStewardSession(relation, initial)).toMatchObject({
      approved_plan_total: 3, approved_plan_completed: 0,
    });
    expect(db.query("SELECT current_plan_revision_id FROM btcc_guided_works WHERE work_id = ?").get(work.workId))
      .toEqual({ current_plan_revision_id: null });

    await service.recordCheckpoint({
      ...turn, mutationCallId: "progress", actionUpdates: [{ actionKey: "implement", status: "done" }],
      publicSummary: "Implementation complete", nextStep: "Review",
    });
    // A newer timestamp on an unrelated Work must not select its plan.
    db.query(`INSERT INTO btcc_guided_works (work_id, session_id, scope_kind, scope_ref,
      origin_turn_id, origin_message_id, objective, status, created_at, updated_at)
      VALUES ('other-work', 'steward', 'session', 'steward', 'other-turn', 'other-message',
        'Unrelated', 'open', '2099-01-01', '2099-01-01')`).run();
    db.query("INSERT INTO btcc_messages VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("assistant-progress", "steward", "turn", "assistant", "Implementation complete", "progress-message", "2026-09-05T00:01:00.000Z");
    const updated = stores.observer.snapshot("steward")!;
    const capsule = projectStewardSession(relation, updated);
    const modal = sessionViewForStewardObserver(relation, updated, 0);
    expect(capsule).toMatchObject({ approved_plan_total: 3, approved_plan_completed: 1 });
    expect(capsule.activity_rows.filter((row) => row.kind === "todo").map((row) => row.state))
      .toEqual(["completed", "pending", "pending"]);
    expect(modal.messages.at(-1)?.turn_activity_rows?.map((row) => [row.safe_label, row.state]))
      .toEqual(capsule.activity_rows.map((row) => [row.safe_label, row.state]));
    insertTurn(db, "next-turn", "steward");
    expect(stores.observer.snapshot("steward")?.plan).toBeNull();
  } finally {
    db.close();
    stores.close();
    rmSync(butlerData, { recursive: true, force: true });
  }
});

function insertTurn(db: Database, turnId: string, sessionId: string) {
  db.query(`INSERT INTO btcc_turns (turn_id, session_id, inbox_id, trigger_key,
    original_message_id, original_message, admission_snapshot_ref, model_selection_json,
    context_json, semantic_state, revision, execution_fence)
    VALUES (?, ?, ?, ?, ?, 'Implement the request', 'snapshot', '{}', '{}', 'admitted', 1, 0)`)
    .run(turnId, sessionId, `inbox-${turnId}`, `trigger-${turnId}`, `message-${turnId}`);
}
