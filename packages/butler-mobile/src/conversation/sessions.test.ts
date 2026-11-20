// test-category: pure-logic
import { expect, test } from "bun:test";
import type { SessionSummary } from "../../../butler-protocol/src/index.ts";
import { sessionMark, titleFromPrompt } from "./sessions";

test("sessionMark prioritizes attention, work, unread", () => {
  const session: SessionSummary = {
    id: "old", kind: "chat", title: "Old", session_hint: "", created_at: "2026-11-18T10:00:00Z",
    updated_at: "2026-11-18T10:00:00Z", last_activity_at: "2026-11-18T10:00:00Z",
    unread: true, pinned: false, archived: false, automation_target_count: 0,
  };
  expect(sessionMark({ ...session, attention_required: true, active_turn_state: "thinking" })).toBe("attention");
  expect(sessionMark({ ...session, active_turn_state: "thinking" })).toBe("working");
  expect(sessionMark({ ...session, running_delegated_work: true })).toBe("working");
  expect(sessionMark(session)).toBe("unread");
});

test("titleFromPrompt shortens a long first line and falls back for empty text", () => {
  expect(titleFromPrompt("  A   long first line that continues beyond forty-eight characters\nSecond line", "New chat"))
    .toBe("A long first line that continues beyond forty...");
  expect(titleFromPrompt(" \n ", "New chat")).toBe("New chat");
});
