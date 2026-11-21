// test-category: pure-logic
import { expect, test } from "bun:test";
import type { SessionView } from "../../../butler-protocol/src/index.ts";
import { applyLiveEvent } from "./sessionView";

test("applyLiveEvent streaming upsert keeps newer text on replay", () => {
  const view: SessionView = {
    session_id: "s1", kind: "chat", status: "active", active_turn: null, latest_turn: null,
    messages: [{ id: "m1", chat_id: "s1", role: "assistant", text: "Hel", status: "streaming", updated_at: "2026-11-19T10:00:01Z" }],
    message_window: { next_cursor: 1, complete: true }, cursors: { messages: 1, events: 0 }, updated_at: "2026-11-19T10:00:01Z",
  };
  const next = applyLiveEvent(view, { id: 1, type: "message.updated", payload: {
    message: { ...view.messages[0], text: "Hello", updated_at: "2026-11-19T10:00:02Z" },
  } });
  if (!next || next === "refetch") throw new Error("Expected a view");
  expect(next.messages[0].text).toBe("Hello");
  const replay = applyLiveEvent(next, { id: 2, type: "message.updated", payload: {
    message: { ...view.messages[0], text: "He", updated_at: "2026-11-19T10:00:00Z" },
  } });
  if (!replay || replay === "refetch") throw new Error("Expected a view");
  expect(replay.messages[0].text).toBe("Hello");
});

test("message.deleted removes the message and session events are routed", () => {
  const view: SessionView = {
    session_id: "s1", kind: "chat", status: "idle", active_turn: null, latest_turn: null,
    messages: [{ id: "m1", chat_id: "s1", role: "assistant", text: "Hello" }],
    message_window: { next_cursor: 1, complete: true }, cursors: { messages: 1, events: 0 }, updated_at: "2026-11-19T10:00:02Z",
  };
  const next = applyLiveEvent(view, { id: 1, type: "message.deleted", payload: { chat_id: "s1", message_id: "m1" } });
  if (!next || next === "refetch") throw new Error("Expected a view");
  expect(next.messages).toEqual([]);
  expect(applyLiveEvent(view, { id: 2, type: "message.deleted", payload: { chat_id: "s2", message_id: "m1" } })).toBeNull();
  expect(applyLiveEvent(view, { id: 3, type: "turn.state_changed", payload: { chat_id: "s1" } })).toBe("refetch");
});

test("a steward child turn state change refetches the parent view", () => {
  const view: SessionView = {
    session_id: "s1", kind: "chat", status: "active", active_turn: null, latest_turn: null, messages: [],
    steward_children: [{
      relation: { relation_id: "r1", parent_session_id: "s1", parent_turn_id: "t1", child_session_id: "c1", anchor_message_id: "u1", created_at: "2026-11-20T00:00:00Z" },
      session_id: "c1", title: "Work", status: "active", active_turn: null, latest_turn: null,
      terminal: false, result: null, updated_at: "2026-11-20T00:00:00Z",
    }],
    message_window: { next_cursor: 0, complete: true }, cursors: { messages: 0, events: 0 }, updated_at: "2026-11-20T00:00:00Z",
  };
  expect(applyLiveEvent(view, { id: 1, type: "turn.state_changed", payload: { session_id: "c1" } })).toBe("refetch");
});
