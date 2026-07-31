import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateAppStoreSchema } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/core/schema.ts";
import { AppEventStore } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/events/event-store.ts";
import { AppTurnProgressEventStore } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/events/turn-progress-event-store.ts";
import { TerminalTurnRetention } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/retention/terminal-turn-retention.ts";
import { TerminalTurnRetentionQueue } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/retention/terminal-turn-retention-queue.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("terminal compaction preserves reconstructed progress and the live replay tail", () => {
  const { db, events, retention, turnProgress } = createHarness("turn-retained");
  turnProgress.appendProgressSummaryEvent("chat-1", "turn-retained", {
    id: "operation-1",
    kind: "tool",
    state: "delivered",
    safe_label: "Inspect current logs",
    safe_tool_name: "Log reader",
    tool_call_id: "request-1",
    tool_result_id: "result-1",
    tool_result_byte_length: 120_000,
  });
  events.append("turn.queued", { turn_id: "turn-retained" });
  events.append("turn.state_changed", {
    turn: { id: "turn-retained", state: "delivered" },
  });
  events.append("agent.turn_event", {
    turn_id: "turn-retained",
    event: { kind: "turn.cancelled", payload: { safeLabel: "Cancelled" } },
  });
  db.query("UPDATE turns SET state = 'delivered' WHERE id = 'turn-retained'").run();
  for (let index = 0; index < 205; index += 1) {
    events.append("settings.updated", { revision: index });
  }
  const before = turnProgress.listProgressRowsForTurn("turn-retained");

  expect(retention.compact({
    turnId: "turn-retained",
    chatId: "chat-1",
    state: "delivered",
    deliveryMetadata: null,
  })).toBe("complete");

  expect(turnProgress.listProgressRowsForTurn("turn-retained")).toEqual(before);
  expect(db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM events
    WHERE turn_id = 'turn-retained'
      AND type IN ('progress.summary', 'agent.turn_event.progress')
  `).get()?.count).toBe(0);
  expect(db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM events
    WHERE turn_id = 'turn-retained'
      AND type IN ('turn.queued', 'turn.state_changed', 'agent.turn_event')
  `).get()?.count).toBe(4);
  expect(retention.read("turn-retained")?.progressRows[0]).toMatchObject({
    tool_call_id: "request-1",
    tool_result_id: "result-1",
    tool_result_byte_length: 120_000,
  });
  expect(retention.read("turn-retained")?.deliveryMetadata).toBeNull();
  db.close();
});

test("large terminal journals compact incrementally without changing the projection", () => {
  const { db, events, retention, turnProgress } = createHarness("turn-incremental");
  for (let index = 0; index < 20; index += 1) {
    turnProgress.appendProgressSummaryEvent("chat-1", "turn-incremental", {
      id: `operation-${index}`,
      kind: "tool",
      state: "delivered",
      safe_label: `Operation ${index}`,
    });
  }
  db.query("UPDATE turns SET state = 'delivered' WHERE id = 'turn-incremental'")
    .run();
  for (let index = 0; index < 205; index += 1) {
    events.append("settings.updated", { revision: index });
  }
  const before = turnProgress.listProgressRowsForTurn("turn-incremental");
  const compact = () => retention.compact({
    turnId: "turn-incremental",
    chatId: "chat-1",
    state: "delivered",
    deliveryMetadata: null,
  });

  let result = compact();
  expect(result).toBe("pending");
  while (result === "pending") result = compact();

  expect(result).toBe("complete");
  expect(turnProgress.listProgressRowsForTurn("turn-incremental")).toEqual(before);
  expect(db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM events
    WHERE turn_id = 'turn-incremental'
      AND type IN ('progress.summary', 'agent.turn_event.progress')
  `).get()?.count).toBe(0);
  expect(db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM events WHERE type = 'settings.updated'
  `).get()?.count).toBe(205);

  turnProgress.appendProgressSummaryEvent("chat-1", "turn-incremental", {
    id: "operation-late",
    kind: "tool",
    state: "delivered",
    safe_label: "Late operation",
  });
  for (let index = 0; index < 205; index += 1) {
    events.append("settings.updated", { revision: 206 + index });
  }
  let lateResult = retention.compact({
    turnId: "turn-incremental",
    chatId: "chat-1",
    state: "delivered",
    deliveryMetadata: null,
  });
  while (lateResult === "pending") {
    lateResult = retention.compact({
      turnId: "turn-incremental",
      chatId: "chat-1",
      state: "delivered",
      deliveryMetadata: null,
    });
  }
  expect(lateResult).toBe("complete");
  expect(turnProgress.listProgressRowsForTurn("turn-incremental"))
    .toContainEqual(expect.objectContaining({ id: "operation-late" }));
  db.close();
});

test("active or unsettled BTCC turns are never compacted", () => {
  const { db, retention } = createHarness("turn-active", false);
  expect(retention.compact({
    turnId: "turn-active",
    chatId: "chat-1",
    state: "thinking",
    deliveryMetadata: null,
  })).toBe("not_ready");
  expect(retention.compact({
    turnId: "turn-active",
    chatId: "chat-1",
    state: "cancelled",
    deliveryMetadata: null,
  })).toBe("not_ready");
  db.close();
});

test("unsettled retention stays pending without spinning and resumes on settlement", async () => {
  let settled = false;
  let calls = 0;
  const queue = new TerminalTurnRetentionQueue({
    terminalTurnPage: () => ({
      turns: [],
      nextCursor: 0,
      hasMore: false,
    }),
    compactTurn: () => {
      calls += 1;
      return settled ? "complete" : "not_ready";
    },
    recordFailure: () => undefined,
  });
  queue.schedule("turn-later");
  await waitUntil(() => calls === 1);
  const waitingCalls = calls;
  await Bun.sleep(50);
  expect(calls).toBe(waitingCalls);

  settled = true;
  queue.schedule("turn-later");
  await waitUntil(() => calls === waitingCalls + 1);
  expect(calls).toBe(waitingCalls + 1);
  queue.close();
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

function createHarness(turnId: string, settled = true) {
  const root = mkdtempSync(join(tmpdir(), "butler-terminal-retention-"));
  roots.push(root);
  const db = new Database(join(root, "app.sqlite"), { create: true });
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
  const btccRetention = { isSettled: () => settled };
  const retention = new TerminalTurnRetention(db, btccRetention);
  let sequence = 0;
  const turnProgress = new AppTurnProgressEventStore({
    db,
    appendEvent: (type, payload) => events.append(type, payload),
    nextSessionTurnEventSequence: () => ++sequence,
    nextTurnEventSequence: () => sequence,
    shouldPersistRuntimeTurnEvent: () => true,
    isTerminalTurn: () => false,
    getTurnRow: () => ({ state: "delivered" }) as never,
    terminalProjectionForTurn: (id) => retention.read(id),
  });
  return { db, events, retention, turnProgress };
}
