import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import { BTCC_SUCCESSOR_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { agentBtccStoragePaths } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/storage-ownership/index.ts";
import { SqliteStewardObserverStore } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/steward-observer-store.ts";
import { createProductionBtccComposition } from "../../packages/butler-agent/src/agent/composition/create-btcc-composition.ts";
import { stewardResumeRequestId } from "../../packages/butler-agent/src/agent/btcc/subsessions/index.ts";
import { sessionHintForRow } from "../../packages/butler-agent/src/gateways/app/domain/sessions/session-read-model.ts";
import { useButlerStore } from "../../packages/butler-app/client/ui/src/app/store.ts";
import { NativeInboundQueue } from "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import {
  createAppCancellationEnvelope,
  createAppResumeEnvelope,
} from "../../packages/butler-agent/src/gateways/core/app-transport.ts";

test("createAppServer canonical navigation and SessionView feed the keyed frontend store", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-steward-route-"));
  const parentSessionId = "parent-route";
  const childSessionId = "steward-route";
  const childTurnId = "steward-route-turn";
  seedObserverDatabase(
    root,
    sessionHintForRow(parentSessionId),
    sessionHintForRow("project-parent-route"),
    childSessionId,
    childTurnId,
  );
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
    expect(parent?.steward_children).toBeUndefined();
    const project = navigation.projects.find(
      (item: { id: string }) => item.id === "project-route",
    );
    expect(project?.sessions?.[0]?.steward_children).toBeUndefined();

    const parentSessionViewResponse = await fetch(
      `${server.url}session-view?session_id=${parentSessionId}`,
    );
    if (!parentSessionViewResponse.ok) {
      throw new Error(await parentSessionViewResponse.text());
    }
    expect(parentSessionViewResponse.ok).toBe(true);
    const parentSessionView = (await parentSessionViewResponse.json()).data;
    expect(parentSessionView.steward_children).toHaveLength(2);
    expect(parentSessionView.steward_children.map(
      (child: { session_id: string }) => child.session_id,
    )).toEqual([childSessionId, "steward-route-2"]);
    expect(parentSessionView.steward_children[0]).toEqual(
      expect.objectContaining({
        relation: expect.objectContaining({
          parent_session_id: sessionHintForRow(parentSessionId),
          ordinal: 1,
        }),
      }),
    );
    expect(parentSessionView.steward_children[1]).toEqual(
      expect.objectContaining({
        relation: expect.objectContaining({ ordinal: 2 }),
      }),
    );

    const projectParentSessionViewResponse = await fetch(
      `${server.url}session-view?session_id=project-parent-route`,
    );
    expect(projectParentSessionViewResponse.ok).toBe(true);
    const projectParentSessionView =
      (await projectParentSessionViewResponse.json()).data;
    expect(projectParentSessionView.steward_children).toEqual([
      expect.objectContaining({
        session_id: "project-child-route",
        relation: expect.objectContaining({
          parent_session_id: sessionHintForRow("project-parent-route"),
        }),
      }),
    ]);

    const sessionViewResponse = await fetch(
      `${server.url}session-view?session_id=${childSessionId}`,
    );
    expect(sessionViewResponse.ok).toBe(true);
    const childView = (await sessionViewResponse.json()).data;
    expect(childView.relation).toMatchObject({
      parent_session_id: sessionHintForRow(parentSessionId),
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
      sessionHintForRow(parentSessionId),
    );
    expect(state.sessionView).toBeNull();

    const cancelResponse = await fetch(`${server.url}steward-relations/relation-route/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent_session_id: parentSessionId }),
    });
    expect(cancelResponse.status).toBe(202);
    const queued = new NativeInboundQueue(root).findIdempotent(createAppCancellationEnvelope({
      chatId: childSessionId,
      sessionId: childSessionId,
      turnId: childTurnId,
      requestId: `app-steward-cancel:relation-route:${childTurnId}`,
      requestedAt: "ignored-by-identity",
    }));
    expect(queued?.envelope.control).toMatchObject({
      kind: "cancel_turn",
      turnId: childTurnId,
    });
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an orphaned Steward Turn is projected as recoverable and queues exact resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-steward-resume-route-"));
  const parentSessionId = "parent-resume";
  const childSessionId = "steward-resume";
  const childTurnId = "steward-resume-turn";
  seedInterruptedObserverDatabase(
    root,
    sessionHintForRow(parentSessionId),
    childSessionId,
    childTurnId,
  );
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
      "Interrupted parent",
      "2026-08-22T00:00:00.000Z",
      "2026-08-22T00:00:00.000Z",
    );

    const parentResponse = await fetch(
      `${server.url}session-view?session_id=${parentSessionId}`,
    );
    if (!parentResponse.ok) throw new Error(await parentResponse.text());
    expect(parentResponse.ok).toBe(true);
    const parentView = (await parentResponse.json()).data;
    expect(parentView.steward_children).toEqual([
      expect.objectContaining({
        session_id: childSessionId,
        status: "failed",
        active_turn: null,
        terminal: false,
        latest_turn: expect.objectContaining({
          id: childTurnId,
          state: "runtime_fault",
          retryable: true,
          cancellable: false,
        }),
      }),
    ]);

    const resumeResponse = await fetch(
      `${server.url}steward-relations/relation-resume/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parent_session_id: parentSessionId }),
      },
    );
    expect(resumeResponse.status).toBe(202);
    const resumeBody = (await resumeResponse.json()).data;
    const queued = new NativeInboundQueue(root).findIdempotent(createAppResumeEnvelope({
      chatId: childSessionId,
      sessionId: childSessionId,
      turnId: childTurnId,
      requestId: resumeBody.request_id,
      requestedAt: "ignored-by-identity",
      originalEventId: "resume-trigger",
      originalMessageId: "steward-message:resume",
      originalMessage: "private delegated input",
    }));
    expect(queued?.envelope.control).toMatchObject({
      kind: "resume_turn",
      turnId: childTurnId,
    });
    expect(queued?.envelope.message).toMatchObject({
      id: "resume-message",
      text: "Resume the interrupted task",
    });
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("production BTCC startup queues one exact orphaned Steward resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-steward-startup-resume-"));
  const childSessionId = "steward-startup-resume";
  const childTurnId = "steward-startup-resume-turn";
  seedInterruptedObserverDatabase(
    root,
    sessionHintForRow("parent-startup-resume"),
    childSessionId,
    childTurnId,
  );
  const composition = createProductionBtccComposition({
    butlerHome: root,
    butlerData: root,
    ownerId: "startup-resume-owner",
  });
  try {
    await composition.ready;
    const db = new Database(agentBtccStoragePaths(root).agentBtccDbPath, { readonly: true });
    const recovery = new SqliteStewardObserverStore(db).recoverableTurns()[0];
    db.close();
    expect(recovery?.turn_id).toBe(childTurnId);
    const queued = new NativeInboundQueue(root).findIdempotent(createAppResumeEnvelope({
      chatId: childSessionId,
      sessionId: childSessionId,
      turnId: childTurnId,
      requestId: stewardResumeRequestId("relation-resume", recovery!.recovery_id),
      requestedAt: "ignored-by-identity",
      originalEventId: "resume-trigger",
      originalMessageId: "resume-message",
      originalMessage: "Resume the interrupted task",
    }));
    expect(queued?.metadata).toMatchObject({
      source: "btcc-steward-startup-recovery",
      relation_id: "relation-resume",
    });
    expect(queued?.envelope.message).toMatchObject({
      id: "resume-message",
      text: "Resume the interrupted task",
    });
  } finally {
    await composition.host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function seedObserverDatabase(
  butlerData: string,
  parentSessionId: string,
  projectParentSessionId: string,
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
      "relation-route-2",
      parentSessionId,
      "parent-turn-route-2",
      "steward-route-2",
      "anchor-route-2",
      2,
      "Second route child",
      "2026-08-19T00:00:30.000Z",
    );
  db.query("INSERT INTO btcc_session_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "project-relation-route",
      projectParentSessionId,
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

function seedInterruptedObserverDatabase(
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
      "relation-resume",
      parentSessionId,
      "parent-turn-resume",
      childSessionId,
      "anchor-resume",
      1,
      "Resume interrupted child",
      "2026-08-22T00:00:00.000Z",
    );
  db.query(`
    INSERT INTO btcc_runtime_owners (
      owner_id, host_id, process_id, process_started_at_ms,
      owner_generation, status, registered_at, closed_at
    ) VALUES (?, ?, ?, ?, 1, 'terminated', ?, ?)
  `).run(
    "dead-owner",
    "local-test-host",
    999999,
    1,
    "2026-08-22T00:00:00.000Z",
    "2026-08-22T00:01:00.000Z",
  );
  db.query(`
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, semantic_state, active_checkpoint_id, revision,
      execution_fence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?, 1, 0)
  `).run(
    childTurnId,
    childSessionId,
    "resume-inbox",
    "resume-trigger",
    "resume-message",
    "Resume the interrupted task",
    "resume-snapshot",
    "{}",
    "{}",
    "checkpoint-resume",
  );
  db.query(`
    INSERT INTO btcc_checkpoints (
      checkpoint_id, turn_id, turn_revision, semantic_state, kind,
      checkpoint_revision, active_claim_id, is_active
    ) VALUES (?, ?, 1, 'admitted', 'runtime', 1, ?, 1)
  `).run("checkpoint-resume", childTurnId, "claim-resume");
  db.query(`
    INSERT INTO btcc_state_claims (
      claim_id, turn_id, turn_revision, semantic_state, checkpoint_id,
      checkpoint_revision, execution_fence, owner_id, owner_generation,
      lease_generation, status
    ) VALUES (?, ?, 1, 'admitted', ?, 1, 0, ?, 1, 1, 'active')
  `).run("claim-resume", childTurnId, "checkpoint-resume", "dead-owner");
  db.close();
}
