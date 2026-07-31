import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateAppStoreSchema } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/core/schema.ts";
import { AppEventStore } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/events/event-store.ts";
import { AppTurnProgressEventStore } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/events/turn-progress-event-store.ts";
import { TerminalTurnRetention } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/retention/terminal-turn-retention.ts";

test("terminal compaction retains more than one thousand ordered activities", () => {
  const harness = createHarness("turn-many");
  for (let index = 0; index < 1_105; index += 1) {
    harness.events.append("progress.summary", {
      session_id: "chat-1",
      turn_id: "turn-many",
      row: activity(index),
    });
  }
  const before = harness.progress.listProgressRowsForTurn("turn-many");
  expect(before).toHaveLength(1_105);
  settleTurnAndAdvanceReplayTail(harness, "turn-many");

  drainCompaction(harness, "turn-many");

  expect(harness.progress.listProgressRowsForTurn("turn-many")).toEqual(before);
  expect(harness.retention.read("turn-many")?.progressRows).toHaveLength(1_105);
  expect(countRows(
    harness.db,
    "app_terminal_turn_progress_rows",
    "turn_id = 'turn-many'",
  )).toBe(1_105);
  expect(countRows(
    harness.db,
    "app_progress_row_identities",
    "turn_id = 'turn-many'",
  )).toBe(0);
  harness.db.close();
});

test("legacy turn index avoids rescanning unrelated event history", () => {
  const harness = createHarness("turn-legacy", true);
  for (let index = 0; index < 4_096; index += 1) {
    harness.events.append("settings.updated", { revision: index });
  }
  for (let index = 0; index < 4; index += 1) {
    harness.events.append("progress.summary", {
      session_id: "chat-1",
      turn_id: "turn-legacy",
      row: activity(index),
    });
  }
  const before = harness.progress.listProgressRowsForTurn("turn-legacy");
  settleTurnAndAdvanceReplayTail(harness, "turn-legacy");

  const calls = drainCompaction(harness, "turn-legacy");

  expect(calls).toBe(1);
  expect(harness.progress.listProgressRowsForTurn("turn-legacy")).toEqual(before);
  expect(countRows(harness.db, "events", "type = 'settings.updated'"))
    .toBe(4_301);
  harness.db.close();
});

test("runtime string booleans keep internal continuation activity private", () => {
  const harness = createHarness("turn-runtime-internal");
  harness.progress.appendTurnEvent("chat-1", "turn-runtime-internal", {
    kind: "tool.progress",
    payload: {
      activityKind: "model",
      state: "running",
      safeLabel: "Runtime internal continuation",
      noVisibleReply: true,
      continuationRequeued: true,
    },
  });

  assertInternalActivityStaysPrivate(harness, "turn-runtime-internal");
});

test("legacy numeric booleans keep internal continuation activity private", () => {
  const harness = createHarness("turn-legacy-internal");
  const eventId = "turn-event-legacy-internal";
  const createdAt = "2026-07-27T00:00:00.000Z";
  harness.db.query(`
    INSERT INTO events (type, turn_id, payload_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run("agent.turn_event", "turn-legacy-internal", JSON.stringify({
    session_id: "chat-1",
    turn_id: "turn-legacy-internal",
    event: {
      id: eventId,
      kind: "tool.progress",
      payload: {
        activityKind: "model",
        noVisibleReply: 1,
        continuation_requeued: 1,
      },
    },
  }), createdAt);
  harness.db.query(`
    INSERT INTO events (type, turn_id, payload_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run("agent.turn_event.progress", "turn-legacy-internal", JSON.stringify({
    session_id: "chat-1",
    turn_id: "turn-legacy-internal",
    event_id: eventId,
    row: {
      id: eventId,
      kind: "model",
      state: "running",
      safe_label: "Legacy internal continuation",
      created_at: createdAt,
    },
  }), createdAt);

  assertInternalActivityStaysPrivate(harness, "turn-legacy-internal");
});

test("terminal identity cleanup remains bounded for a very large turn", () => {
  const harness = createHarness("turn-identities");
  for (let index = 0; index < 1_105; index += 1) {
    harness.db.query(`
      INSERT INTO app_progress_row_identities (turn_id, row_json)
      VALUES (?, ?)
    `).run("turn-identities", JSON.stringify(activity(index)));
  }
  harness.db.query("UPDATE turns SET state = 'delivered' WHERE id = ?")
    .run("turn-identities");

  expect(harness.retention.compact({
    turnId: "turn-identities",
    chatId: "chat-1",
    state: "delivered",
    deliveryMetadata: null,
  })).toBe("pending");
  expect(countRows(
    harness.db,
    "app_progress_row_identities",
    "turn_id = 'turn-identities'",
  )).toBe(1_105 - 64);

  drainCompaction(harness, "turn-identities");
  expect(countRows(
    harness.db,
    "app_progress_row_identities",
    "turn_id = 'turn-identities'",
  )).toBe(0);
  harness.db.close();
});

function createHarness(turnId: string, legacyEvents = false) {
  const db = new Database(":memory:");
  if (legacyEvents) createLegacyEventSchema(db);
  migrateAppStoreSchema(db);
  const now = new Date().toISOString();
  db.query(`
    INSERT INTO chats (id, title, kind, created_at, updated_at)
    VALUES ('chat-1', 'Retention', 'chat', ?, ?)
  `).run(now, now);
  db.query(`
    INSERT INTO turns (
      id, chat_id, state, safe_status_label, retryable, cancellable,
      attempt, created_at, updated_at
    ) VALUES (?, 'chat-1', 'running', 'Working', 0, 1, 1, ?, ?)
  `).run(turnId, now, now);
  const events = new AppEventStore(db);
  const retention = new TerminalTurnRetention(db, {
    isSettled: () => true,
  });
  let sequence = 0;
  const progress = new AppTurnProgressEventStore({
    db,
    appendEvent: (type, payload) => events.append(type, payload),
    nextSessionTurnEventSequence: () => ++sequence,
    nextTurnEventSequence: () => sequence,
    shouldPersistRuntimeTurnEvent: () => true,
    isTerminalTurn: () => false,
    getTurnRow: () => ({ state: "delivered" }) as never,
    terminalProjectionForTurn: (id) => retention.read(id),
  });
  return { db, events, retention, progress };
}

function createLegacyEventSchema(db: Database): void {
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX events_type_turn_id_idx
    ON events(type, json_extract(payload_json, '$.turn_id'), id DESC);
  `);
}

function activity(index: number) {
  return {
    id: `activity-${index.toString().padStart(4, "0")}`,
    kind: "tool",
    state: "delivered",
    safe_label: `Activity ${index}`,
    created_at: new Date(1_700_000_000_000 + index).toISOString(),
  };
}

function assertInternalActivityStaysPrivate(
  harness: ReturnType<typeof createHarness>,
  turnId: string,
): void {
  expect(harness.progress.listProgressRowsForTurn(turnId)).toEqual([]);
  settleTurnAndAdvanceReplayTail(harness, turnId);
  drainCompaction(harness, turnId);
  expect(harness.progress.listProgressRowsForTurn(turnId)).toEqual([]);
  expect(harness.retention.read(turnId)?.progressRows).toEqual([]);
  expect(countRows(
    harness.db,
    "app_internal_continuation_progress_events",
    `turn_id = '${turnId}'`,
  )).toBe(0);
  harness.db.close();
}

function settleTurnAndAdvanceReplayTail(
  harness: ReturnType<typeof createHarness>,
  turnId: string,
): void {
  harness.db.query("UPDATE turns SET state = 'delivered' WHERE id = ?")
    .run(turnId);
  for (let index = 0; index < 205; index += 1) {
    harness.events.append("settings.updated", { revision: 10_000 + index });
  }
}

function drainCompaction(
  harness: ReturnType<typeof createHarness>,
  turnId: string,
): number {
  let calls = 0;
  let result: ReturnType<TerminalTurnRetention["compact"]>;
  do {
    calls += 1;
    result = harness.retention.compact({
      turnId,
      chatId: "chat-1",
      state: "delivered",
      deliveryMetadata: null,
    });
  } while (result === "pending");
  expect(result).toBe("complete");
  return calls;
}

function countRows(db: Database, table: string, where: string): number {
  return db.query<{ count: number }, []>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`,
  ).get()?.count ?? 0;
}
