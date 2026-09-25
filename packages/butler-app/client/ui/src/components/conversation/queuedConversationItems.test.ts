/// <reference types="bun" />
import { expect, test } from "bun:test";
import type { MessageRecord, QueuedMessageRecord } from "@/app/types.ts";
import { queuedConversationItems, queuedMessageKey } from "./queuedConversationItems";

function queued(id: string, state: QueuedMessageRecord["state"] = "queued", clientId?: string): QueuedMessageRecord {
  return {
    id,
    chat_id: "chat",
    text: id,
    ...(clientId ? { client_message_id: clientId } : {}),
    controls: { model: "m", reasoning_effort: "medium", access_mode: "full_access", plan_mode: false },
    state,
    cursor: 1,
    created_at: "2026-09-25T00:00:00.000Z",
    updated_at: "2026-09-25T00:00:00.000Z",
  };
}

function message(id: string): MessageRecord {
  return { id, chat_id: "chat", role: "user", text: id, cursor: 1, created_at: "", updated_at: "" } as MessageRecord;
}

test("queued records are keyed by their client message id so the optimistic row keeps its identity", () => {
  expect(queuedMessageKey(queued("server-1", "queued", "client-1"))).toBe("client-1");
  expect(queuedMessageKey(queued("server-2"))).toBe("server-2");
});

test("waiting messages get positions and failed sends keep their tone", () => {
  const items = queuedConversationItems({
    queue: [queued("a"), queued("b"), queued("c", "failed")],
    messages: [],
  });
  expect(items.map((item) => [item.key, item.tone, item.position, item.total])).toEqual([
    ["a", "queued", 1, 2],
    ["b", "queued", 2, 2],
    ["c", "failed", 0, 2],
  ]);
  // Send now waits for a gateway API (owner decision): no item offers it.
  expect(items.some((item) => "canSendNow" in item)).toBe(false);
});

test("a record already shown as a message is hidden", () => {
  const items = queuedConversationItems({
    queue: [queued("server-1", "queued", "client-1"), { ...queued("server-2"), dispatched_message_id: "m-2" }, queued("server-3")],
    messages: [message("client-1"), message("m-2")],
  });
  expect(items.map((item) => item.key)).toEqual(["server-3"]);
  expect(items[0]!.position).toBe(1);
  expect(items[0]!.total).toBe(1);
});
