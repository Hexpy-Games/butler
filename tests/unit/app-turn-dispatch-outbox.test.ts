import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateAppStoreSchema } from "../../packages/butler-agent/src/gateways/app/infrastructure/core/schema.ts";
import {
  readAppTurnDispatchIntent,
  reconcileAppTurnDispatchOutbox,
  recordAppTurnDispatchIntent,
} from "../../packages/butler-agent/src/gateways/app/infrastructure/transport/app-turn-dispatch-outbox.ts";
import { FileQueueButlerServiceClient } from "../../packages/butler-agent/src/gateways/core/client.ts";
import type { AppInboundInput } from "../../packages/butler-agent/src/gateways/core/app-transport.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function fixture(): { butlerData: string; dbPath: string; db: Database } {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-app-dispatch-outbox-"));
  tempDirs.push(butlerData);
  const dbPath = join(butlerData, "app.sqlite");
  const db = new Database(dbPath);
  migrateAppStoreSchema(db);
  db.query(`
    INSERT INTO chats (id, title, kind, created_at, updated_at)
    VALUES ('general', 'General', 'chat', ?, ?)
  `).run("2026-07-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z");
  db.query(`
    INSERT INTO turns (
      id, chat_id, state, safe_status_label, retryable, cancellable,
      attempt, created_at, updated_at
    ) VALUES (?, 'general', 'thinking', 'Thinking', 0, 1, 1, ?, ?)
  `).run(
    "turn-outbox",
    "2026-07-15T00:00:00.000Z",
    "2026-07-15T00:00:00.000Z",
  );
  return { butlerData, dbPath, db };
}

function appInput(): AppInboundInput {
  return {
    chatId: "general",
    messageId: "message-outbox",
    turnId: "turn-outbox",
    text: "continue",
    timestamp: "2026-07-15T00:00:00.000Z",
    sessionId: "butler/app-general",
    rawSource: "test",
  };
}

test("file queue client materializes one record for the same dispatch identity", () => {
  const { butlerData, db } = fixture();
  const client = new FileQueueButlerServiceClient({ butlerData });

  const first = client.enqueueAppTurn(appInput(), {
    source: "test",
    idempotencyKey: "app-turn-dispatch:turn-outbox",
  });
  const replay = client.enqueueAppTurn(appInput(), {
    source: "test",
    idempotencyKey: "app-turn-dispatch:turn-outbox",
  });

  expect(replay.queueId).toBe(first.queueId);
  expect(readdirSync(join(butlerData, "runtime", "inbound-events", "pending")))
    .toHaveLength(1);
  db.close();
});

test("dispatch outbox reconciles only after runtime wake revision changes", () => {
  const { butlerData, dbPath, db } = fixture();
  recordAppTurnDispatchIntent(db, {
    turnId: "turn-outbox",
    chatId: "general",
    input: appInput(),
    metadata: { source: "test" },
    observedWakeRevisionRef: "runtime:offline",
    createdAt: "2026-07-15T00:00:00.000Z",
  });

  expect(reconcileAppTurnDispatchOutbox({
    dbPath,
    butlerData,
    wakeRevisionRef: "runtime:offline",
  })).toEqual({ inspected: 0, committed: 0, preserved: 0 });

  expect(reconcileAppTurnDispatchOutbox({
    dbPath,
    butlerData,
    wakeRevisionRef: "runtime:online:1",
    now: new Date("2026-07-15T00:00:01.000Z"),
  })).toEqual({ inspected: 1, committed: 1, preserved: 0 });
  expect(readAppTurnDispatchIntent(db, "turn-outbox")).toMatchObject({
    state: "committed",
    observed_wake_revision_ref: "runtime:offline",
    queue_id: expect.any(String),
  });
  expect(readdirSync(join(butlerData, "runtime", "inbound-events", "pending")))
    .toHaveLength(1);
  expect(reconcileAppTurnDispatchOutbox({
    dbPath,
    butlerData,
    wakeRevisionRef: "runtime:online:1",
  })).toEqual({ inspected: 0, committed: 0, preserved: 0 });

  db.close();
});

test("failed materialization records the observed revision and does not retry unchanged evidence", () => {
  const { butlerData, dbPath, db } = fixture();
  recordAppTurnDispatchIntent(db, {
    turnId: "turn-outbox",
    chatId: "general",
    input: appInput(),
    metadata: { source: "test" },
    observedWakeRevisionRef: "runtime:offline",
    createdAt: "2026-07-15T00:00:00.000Z",
  });
  let calls = 0;
  const serviceClient = {
    enqueueAppTurn() {
      calls += 1;
      throw new Error("queue filesystem unavailable");
    },
  };

  expect(reconcileAppTurnDispatchOutbox({
    dbPath,
    butlerData,
    wakeRevisionRef: "runtime:online:1",
    serviceClient,
  })).toEqual({ inspected: 1, committed: 0, preserved: 1 });
  expect(reconcileAppTurnDispatchOutbox({
    dbPath,
    butlerData,
    wakeRevisionRef: "runtime:online:1",
    serviceClient,
  })).toEqual({ inspected: 0, committed: 0, preserved: 0 });
  expect(calls).toBe(1);
  expect(readAppTurnDispatchIntent(db, "turn-outbox")).toMatchObject({
    state: "pending",
    observed_wake_revision_ref: "runtime:online:1",
    queue_id: null,
  });

  db.close();
});

test("crash after queue materialization reconciles the same queue record before commit", () => {
  const { butlerData, dbPath, db } = fixture();
  recordAppTurnDispatchIntent(db, {
    turnId: "turn-outbox",
    chatId: "general",
    input: appInput(),
    metadata: { source: "test" },
    observedWakeRevisionRef: "dispatch-unattempted:turn-outbox",
    createdAt: "2026-07-15T00:00:00.000Z",
  });
  const client = new FileQueueButlerServiceClient({ butlerData });
  const materialized = client.enqueueAppTurn(appInput(), {
    source: "test",
    idempotencyKey: "app-turn-dispatch:turn-outbox",
  });

  expect(reconcileAppTurnDispatchOutbox({
    dbPath,
    butlerData,
    wakeRevisionRef: "runtime:online:1",
    now: new Date("2026-07-15T00:00:01.000Z"),
  })).toEqual({ inspected: 1, committed: 1, preserved: 0 });
  expect(readAppTurnDispatchIntent(db, "turn-outbox")).toMatchObject({
    state: "committed",
    queue_id: materialized.queueId,
  });
  expect(readdirSync(join(butlerData, "runtime", "inbound-events", "pending")))
    .toHaveLength(1);

  db.close();
});
