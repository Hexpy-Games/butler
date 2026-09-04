/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openBtccAuthorityStore,
  openBtccSqliteStores,
} from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/open-btcc-sqlite-stores.ts";
import { createAppServer } from
  "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import { NativeInboundQueue } from
  "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Steward and Worker ask-first decisions return to their source Sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-descendant-authority-"));
  roots.push(root);
  const dbPath = join(root, "agent-runtime", "btcc.sqlite");
  const ownerSessionId = "butler/app-general";
  const stewardSessionId = "steward-authority-child";
  const workerSessionId = "worker-authority-child";
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: "descendant-authority-seed",
    storageProfile: "ephemeral",
  });
  const db = new Database(dbPath);
  try {
    insertTurn(db, stewardSessionId, "steward-authority-origin");
    insertTurn(db, workerSessionId, "worker-authority-origin");
    db.query("INSERT INTO btcc_session_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "relation-authority-steward",
        ownerSessionId,
        "parent-authority-turn",
        stewardSessionId,
        "parent-authority-message",
        1,
        "Steward authority",
        "2026-09-04T00:00:00.000Z",
      );
    db.query("INSERT INTO btcc_session_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "relation-authority-worker",
        stewardSessionId,
        "steward-authority-turn",
        workerSessionId,
        "steward-authority-message",
        1,
        "Worker authority",
        "2026-09-04T00:00:01.000Z",
      );
  } finally {
    db.close();
  }
  const stewardWork = await stores.durableWork.startWork({
    sessionId: stewardSessionId,
    turnId: "steward-authority-origin",
    mutationCallId: "start-steward-authority-work",
    objective: "Run the Steward operation after approval",
  });
  const workerWork = await stores.durableWork.startWork({
    sessionId: workerSessionId,
    turnId: "worker-authority-origin",
    mutationCallId: "start-worker-authority-work",
    objective: "Run the Worker operation after approval",
  });
  stores.close();

  const seeded = openBtccAuthorityStore({ butlerData: root });
  const stewardRequest = seeded.authority.admit({
    ownerSessionId,
    sourceSessionId: stewardSessionId,
    sourceTurnId: "steward-authority-origin",
    sourceWorkId: stewardWork.workId,
    workspacePath: root,
    planRevisionId: "steward-authority-plan",
    actionKey: "run-steward-operation",
    authorityGeneration: 1,
    capability: "run_command",
    target: "workspace-command:.",
    normalizedInput: {
      command: "true",
      cwd: ".",
      state_effect: "mutation",
    },
    modelRef: "openai/gpt-5.5",
    reasoningEffort: "low",
  });
  const workerRequest = seeded.authority.admit({
    ownerSessionId,
    sourceSessionId: workerSessionId,
    sourceTurnId: "worker-authority-origin",
    sourceWorkId: workerWork.workId,
    workspacePath: root,
    planRevisionId: "worker-authority-plan",
    actionKey: "run-worker-operation",
    authorityGeneration: 1,
    capability: "run_command",
    target: "workspace-command:.",
    normalizedInput: {
      command: "true",
      cwd: ".",
      state_effect: "mutation",
    },
    modelRef: "openai/gpt-5.5",
    reasoningEffort: "low",
  });
  seeded.close();
  if (stewardRequest.status !== "pending" || workerRequest.status !== "pending") {
    throw new Error("descendant authority request was not pending");
  }

  const server = createAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    butlerHome: root,
    port: 0,
  });
  try {
    const listed = await fetch(`${server.url}authority-requests?session_id=general`);
    expect(listed.status).toBe(200);
    expect((await listed.json()).data.requests).toHaveLength(2);

    for (const expected of [
      {
        requestRef: stewardRequest.requestRef,
        sourceSessionId: stewardSessionId,
        parentSessionId: ownerSessionId,
      },
      {
        requestRef: workerRequest.requestRef,
        sourceSessionId: workerSessionId,
        parentSessionId: stewardSessionId,
      },
    ]) {
      const response = await fetch(
        `${server.url}authority-requests/${encodeURIComponent(expected.requestRef)}/allow?session_id=general`,
        { method: "POST" },
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        data: {
          request_ref: expected.requestRef,
          decision: "allowed",
          scheduled: true,
        },
      });
      const queued = new NativeInboundQueue(root).findIdempotent({
        eventId: `authority-continuation:${expected.requestRef}`,
        transport: "app",
        accountId: "local",
        peer: { kind: "dm", id: expected.sourceSessionId },
        sender: { id: "test" },
        message: { id: "test", timestamp: "2026-09-04T00:00:00.000Z" },
      });
      expect(queued?.envelope.peer).toEqual({
        kind: "dm",
        id: expected.sourceSessionId,
        parentId: expected.parentSessionId,
      });
      expect(queued?.envelope.routingHints).toMatchObject({
        sessionId: expected.sourceSessionId,
        authorityRequestRef: expected.requestRef,
      });
      expect(queued?.envelope.message.text)
        .toBe("Continue the approved operation exactly once.");
    }
  } finally {
    server.stop();
  }
});

function insertTurn(db: Database, sessionId: string, turnId: string): void {
  db.query(`
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, semantic_state, revision, execution_fence
    ) VALUES (?, ?, ?, ?, ?, 'approve this operation', 'snapshot', '{}', '{}',
      'admitted', 1, 0)
  `).run(
    turnId,
    sessionId,
    `inbox-${turnId}`,
    `trigger-${turnId}`,
    `message-${turnId}`,
  );
}
