import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { AppSessionMessageProjectionStore } from
  "../../packages/butler-agent/src/gateways/app/domain/sessions/session-message-projection-store.ts";

test("initial and reloaded session messages retain canonical Work progress", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY, type TEXT NOT NULL, payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL, turn_id TEXT NOT NULL DEFAULT ''
    )
  `);
  const progressRows = [{
    id: "task-1",
    kind: "todo",
    state: "reviewing",
    safe_label: "Verify reconnect equivalence",
    safe_input_label: "task-1",
    bridge_phase: "btcc_work_ledger",
    work_stream_id: "work-1",
    semantic_block_id: "work-ledger-program-1",
    created_at: "2026-07-27T00:00:00.000Z",
  }];
  const messages = [{
    id: "assistant-1",
    chat_id: "chat-1",
    turn_id: "turn-1",
    role: "assistant",
    text: "Done",
    status: "delivered",
    retryable: false,
    cursor: 2,
    created_at: "2026-07-27T00:00:00.000Z",
    updated_at: "2026-07-27T00:00:01.000Z",
  }];
  const store = new AppSessionMessageProjectionStore({
    listMessages: () => messages as never,
    getTurnRow: () => ({ state: "delivered" }) as never,
    listProgressRowsForTurn: () => progressRows as never,
    explicitDeliveryMetadataForTurn: () => null,
  });

  const first = store.sessionViewMessages("chat-1");
  const reloaded = store.sessionViewMessages("chat-1");
  expect(first[0]?.turn_activity_rows).toEqual([{
    ...progressRows[0],
    state: "delivered",
  }]);
  expect(reloaded).toEqual(first);
  db.close();
});
