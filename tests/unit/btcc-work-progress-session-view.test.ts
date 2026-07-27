import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { AppSessionMessageProjectionStore } from
  "../../packages/butler-agent/src/gateways/app/domain/sessions/session-message-projection-store.ts";
import { AppTurnProgressViewStore } from
  "../../packages/butler-agent/src/gateways/app/domain/sessions/turn-progress-view-store.ts";

test("initial and reloaded terminal messages retain canonical Work progress", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY, type TEXT NOT NULL, payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL, turn_id TEXT NOT NULL DEFAULT ''
    )
  `);
  const progressRows = ["completed", "stopped", "planned"].map((state, index) => ({
    id: `task-${index + 1}`,
    kind: "todo",
    state,
    safe_label: `Task ${index + 1}`,
    safe_input_label: `task-${index + 1}`,
    bridge_phase: "btcc_work_ledger",
    work_stream_id: "work-1",
    semantic_block_id: "work-ledger-program-1",
    created_at: "2026-07-27T00:00:00.000Z",
  }));
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
  expect(first[0]?.turn_activity_rows).toEqual(progressRows);
  expect(reloaded).toEqual(first);

  const turnProgress = new AppTurnProgressViewStore({
    getTurnRow: () => ({
      rowid: 1,
      id: "turn-1",
      chat_id: "chat-1",
      user_message_id: "user-1",
      state: "delivered",
      safe_status_label: "",
      safe_error_code: null,
      retryable: 0,
      cancellable: 0,
      attempt: 1,
      created_at: "2026-07-27T00:00:00.000Z",
      updated_at: "2026-07-27T00:00:01.000Z",
    }),
    listProgressRowsForTurn: () => progressRows as never,
    deliveryMetadataForTurnRecord: () => ({
      delivery_state: "delivered",
      limitation_codes: [],
      limitations: [],
    }),
  }).listForMessages(messages as never);
  expect(turnProgress["turn-1"]?.safe_progress_rows).toEqual(progressRows);
  db.close();
});
