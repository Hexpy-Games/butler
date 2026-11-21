// test-category: pure-logic
import { expect, test } from "bun:test";
import type { ConversationMessage, SessionView, StewardChild } from "../../../butler-protocol/src/index.ts";
import { anchoredStewardChildren } from "./stewardAnchors";

test("anchors the child to the assistant after its user request", () => {
  const messages: ConversationMessage[] = [
    { id: "u1", chat_id: "s1", role: "user", text: "Request" },
    { id: "a1", chat_id: "s1", role: "assistant", text: "", turn_id: "t1" },
  ];
  const child: StewardChild = {
    relation: { relation_id: "r1", parent_session_id: "s1", parent_turn_id: "t1", child_session_id: "c1", anchor_message_id: "u1", created_at: "2026-11-20T00:00:00Z" },
    session_id: "c1", title: "Work", status: "active", terminal: false, result: null, latest_turn: null,
    active_turn: { id: "ct1", state: "thinking", cancellable: true, retryable: false, created_at: "2026-11-20T00:00:00Z", updated_at: "2026-11-20T00:00:00Z" },
    updated_at: "2026-11-20T00:00:00Z",
  };
  const view: SessionView = {
    session_id: "s1", kind: "chat", status: "active", active_turn: null, latest_turn: null, messages,
    steward_children: [child], message_window: { next_cursor: 2, complete: true },
    cursors: { messages: 2, events: 0 }, updated_at: "2026-11-20T00:00:00Z",
  };
  expect(anchoredStewardChildren(messages, view).get("a1")?.child.session_id).toBe("c1");
});

test("drops two children with the same parent anchors", () => {
  const messages: ConversationMessage[] = [
    { id: "u1", chat_id: "s1", role: "user", text: "Request" },
    { id: "a1", chat_id: "s1", role: "assistant", text: "", turn_id: "t1" },
  ];
  const child: StewardChild = {
    relation: { relation_id: "r1", parent_session_id: "s1", parent_turn_id: "t1", child_session_id: "c1", anchor_message_id: "u1", created_at: "2026-11-20T00:00:00Z" },
    session_id: "c1", title: "Work", status: "active", terminal: false, result: null, latest_turn: null,
    active_turn: { id: "ct1", state: "thinking", cancellable: true, retryable: false, created_at: "2026-11-20T00:00:00Z", updated_at: "2026-11-20T00:00:00Z" },
    updated_at: "2026-11-20T00:00:00Z",
  };
  const view: SessionView = {
    session_id: "s1", kind: "chat", status: "active", active_turn: null, latest_turn: null, messages,
    steward_children: [child, { ...child, session_id: "c2", relation: { ...child.relation, relation_id: "r2", child_session_id: "c2" } }],
    message_window: { next_cursor: 2, complete: true }, cursors: { messages: 2, events: 0 }, updated_at: "2026-11-20T00:00:00Z",
  };
  expect(anchoredStewardChildren(messages, view).size).toBe(0);
});

test("anchors a missing user request only for an initiated assistant turn", () => {
  const messages: ConversationMessage[] = [
    { id: "a1", chat_id: "s1", role: "assistant", text: "", turn_id: "t1", initiated: { kind: "canon_step" } },
  ];
  const child: StewardChild = {
    relation: { relation_id: "r1", parent_session_id: "s1", parent_turn_id: "t1", child_session_id: "c1", anchor_message_id: "u1", created_at: "2026-11-20T00:00:00Z" },
    session_id: "c1", title: "Work", status: "active", terminal: false, result: null, latest_turn: null,
    active_turn: { id: "ct1", state: "thinking", cancellable: true, retryable: false, created_at: "2026-11-20T00:00:00Z", updated_at: "2026-11-20T00:00:00Z" },
    updated_at: "2026-11-20T00:00:00Z",
  };
  const view: SessionView = {
    session_id: "s1", kind: "chat", status: "active", active_turn: null, latest_turn: null, messages,
    steward_children: [child], message_window: { next_cursor: 1, complete: true },
    cursors: { messages: 1, events: 0 }, updated_at: "2026-11-20T00:00:00Z",
  };
  expect(anchoredStewardChildren(messages, view).get("a1")?.child.session_id).toBe("c1");
  expect(anchoredStewardChildren([{ ...messages[0], initiated: undefined }], view).size).toBe(0);
});
