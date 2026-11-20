// test-category: pure-logic
import { expect, test } from "bun:test";
import type { QueuedMessageRecord } from "../../../butler-protocol/src/index.ts";
import { queuedConversationItems } from "./queue";

test("queuedConversationItems hides delivered records and numbers waiting messages", () => {
  const record: QueuedMessageRecord = {
    id: "first", chat_id: "chat", text: "First", state: "queued", cursor: 1,
    controls: { model: "model", reasoning_effort: "none", access_mode: "ask_first", plan_mode: false },
    created_at: "2026-11-20T00:00:00Z", updated_at: "2026-11-20T00:00:00Z",
  };
  const items = queuedConversationItems([
    { ...record, id: "delivered", state: "dispatched", dispatched_message_id: "message" },
    record,
    { ...record, id: "failed", state: "failed" },
    { ...record, id: "second" },
  ], [{ id: "message", role: "user", text: "Delivered" }]);
  expect(items.map(item => ({ id: item.record.id, position: item.position, total: item.total, canSendNow: item.canSendNow })))
    .toEqual([
      { id: "first", position: 1, total: 2, canSendNow: true },
      { id: "failed", position: 0, total: 2, canSendNow: false },
      { id: "second", position: 2, total: 2, canSendNow: false },
    ]);
});
