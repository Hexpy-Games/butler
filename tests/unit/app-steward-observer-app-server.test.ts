import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import { BTCC_SUCCESSOR_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { agentBtccStoragePaths } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/storage-ownership/index.ts";
import { useButlerStore } from "../../packages/butler-app/client/ui/src/app/store.ts";

test("createAppServer canonical navigation and SessionView feed the keyed frontend store", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-steward-route-"));
  const parentSessionId = "parent-route";
  const childSessionId = "steward-route";
  const childTurnId = "steward-route-turn";
  seedObserverDatabase(root, parentSessionId, childSessionId, childTurnId);
  const server = createAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  try {
    server.store.db.query(
      `INSERT INTO chats (id, title, kind, pinned, archived, created_at, updated_at)
       VALUES (?, ?, 'chat', 0, 0, ?, ?)`,
    ).run(
      parentSessionId,
      "Parent route",
      "2026-08-19T00:00:00.000Z",
      "2026-08-19T00:00:00.000Z",
    );
    server.store.db.query(
      `INSERT INTO projects (
        id, display_name, status, workspace_path, workspace_label, safe_path_label,
        pinned, archived, created_at, updated_at
      ) VALUES (?, ?, 'active', ?, ?, ?, 0, 0, ?, ?)`,
    ).run(
      "project-route",
      "Project route",
      root,
      "Project route",
      "Project route",
      "2026-08-19T00:00:00.000Z",
      "2026-08-19T00:00:00.000Z",
    );
    server.store.db.query(
      `INSERT INTO chats (id, title, kind, project_id, pinned, archived, created_at, updated_at)
       VALUES (?, ?, 'project', ?, 0, 0, ?, ?)`,
    ).run(
      "project-parent-route",
      "Project session route",
      "project-route",
      "2026-08-19T00:00:00.000Z",
      "2026-08-19T00:00:00.000Z",
    );

    const navigationResponse = await fetch(`${server.url}navigation`);
    expect(navigationResponse.ok).toBe(true);
    const navigation = (await navigationResponse.json()).data;
    const parent = navigation.chats.find(
      (session: { id: string }) => session.id === parentSessionId,
    );
    expect(parent?.steward_children).toEqual([
      expect.objectContaining({
        id: childSessionId,
        parent_session_id: parentSessionId,
        is_steward_child: true,
      }),
    ]);
    const project = navigation.projects.find(
      (item: { id: string }) => item.id === "project-route",
    );
    expect(project?.sessions?.[0]?.steward_children).toEqual([
      expect.objectContaining({
        parent_session_id: "project-parent-route",
        is_steward_child: true,
        id: "project-child-route",
      }),
    ]);

    const sessionViewResponse = await fetch(
      `${server.url}session-view?session_id=${childSessionId}`,
    );
    expect(sessionViewResponse.ok).toBe(true);
    const childView = (await sessionViewResponse.json()).data;
    expect(childView.relation).toMatchObject({
      parent_session_id: parentSessionId,
      child_session_id: childSessionId,
    });
    expect(childView.latest_turn.id).toBe(childTurnId);
    expect(childView.latest_turn.progress.safe_progress_rows).toEqual([
      expect.objectContaining({
        safe_input_label: "action-1",
        state: "pending",
      }),
    ]);

    const store = useButlerStore.getState();
    store.setActiveChatId(parentSessionId);
    store.openSessionObserver(childSessionId);
    store.setSessionView(childView);
    const state = useButlerStore.getState();
    expect(state.activeChatId).toBe(parentSessionId);
    expect(state.observerSessionId).toBe(childSessionId);
    expect(state.sessionViews[childSessionId]?.relation?.parent_session_id).toBe(
      parentSessionId,
    );
    expect(state.sessionView).toBeNull();
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

function seedObserverDatabase(
  butlerData: string,
  parentSessionId: string,
  childSessionId: string,
  childTurnId: string,
): void {
  const dbPath = agentBtccStoragePaths(butlerData).agentBtccDbPath;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  db.query("INSERT INTO btcc_session_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "relation-route",
      parentSessionId,
      "parent-turn-route",
      childSessionId,
      "anchor-route",
      1,
      "Route child",
      "2026-08-19T00:00:00.000Z",
    );
  db.query("INSERT INTO btcc_session_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "project-relation-route",
      "project-parent-route",
      "project-parent-turn",
      "project-child-route",
      "project-anchor-route",
      1,
      "Project child",
      "2026-08-19T00:00:00.000Z",
    );
  db.query(`
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, semantic_state, revision, execution_fence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', 1, 0)
  `).run(
    childTurnId,
    childSessionId,
    "route-inbox",
    "route-trigger",
    "route-message",
    "Review the route",
    "route-snapshot",
    "{}",
    "{}",
  );
  db.query("INSERT INTO btcc_messages VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(
      "route-message",
      childSessionId,
      childTurnId,
      "user",
      "Review the route",
      "route-message-key",
      "2026-08-19T00:01:00.000Z",
    );
  db.query("INSERT INTO btcc_guided_works VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "route-work",
      childSessionId,
      "session",
      childSessionId,
      childTurnId,
      "route-message",
      "Route plan",
      "open",
      "route-plan",
      "2026-08-19T00:01:00.000Z",
      "2026-08-19T00:02:00.000Z",
    );
  db.query("INSERT INTO btcc_guided_work_plan_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "route-plan",
      "route-work",
      4,
      "Route plan",
      "[]",
      JSON.stringify([
        { actionKey: "action-1", description: "Read the route" },
      ]),
      "[]",
      childTurnId,
      "2026-08-19T00:01:30.000Z",
    );
  db.query("INSERT INTO btcc_guided_work_review_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "route-review",
      "route-work",
      1,
      "plan",
      "accept",
      "Accepted",
      "[]",
      "route-plan",
      null,
      null,
      null,
      childTurnId,
      "2026-08-19T00:01:45.000Z",
    );
  db.close();
}
