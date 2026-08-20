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
    isPublicMessage: () => true,
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

test("reloaded terminal messages retain R3 activity with optional detail omitted", () => {
  const activity = {
    id: "reporting-activity",
    kind: "message",
    state: "delivered",
    safe_label: "요청한 결과를 전달했습니다.",
    semantic_block_id: "guided-activity:turn-r3:reporting",
    activity_stage: "reporting",
    work_decision_summary: "요청한 결과를 전달했습니다.",
    work_decision_source: "model-authored",
    created_at: "2026-08-02T00:00:01.000Z",
  };
  const message = {
    id: "assistant-r3",
    chat_id: "chat-r3",
    turn_id: "turn-r3",
    role: "assistant",
    text: "요청한 결과를 전달했습니다.",
    status: "delivered",
    retryable: false,
    cursor: 2,
    created_at: "2026-08-02T00:00:00.000Z",
    updated_at: "2026-08-02T00:00:01.000Z",
  };
  const store = new AppSessionMessageProjectionStore({
    listMessages: () => [message] as never,
    getTurnRow: () => ({ state: "delivered" }) as never,
    listProgressRowsForTurn: () => [activity] as never,
    explicitDeliveryMetadataForTurn: () => null,
    isPublicMessage: () => true,
  });

  const completed = store.messageWithTerminalWorkBlocks(message as never, "turn-r3");
  const first = store.sessionViewMessages("chat-r3");
  const reloaded = store.sessionViewMessages("chat-r3");

  expect(completed.turn_activity_rows).toEqual([activity]);
  expect(first[0]?.turn_activity_rows).toEqual([activity]);
  expect(reloaded).toEqual(first);
});
