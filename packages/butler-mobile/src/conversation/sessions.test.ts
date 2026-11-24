// test-category: pure-logic
import { expect, test } from "bun:test";
import type { SessionSummary } from "../../../butler-protocol/src/index.ts";
import { sessionMark, sessionSubtitle, titleFromPrompt } from "./sessions";

const session: SessionSummary = {
  id: "old", kind: "chat", title: "Old", session_hint: "", created_at: "2026-11-18T10:00:00Z",
  updated_at: "2026-11-18T10:00:00Z", last_activity_at: "2026-11-18T10:00:00Z",
  unread: true, pinned: false, archived: false, automation_target_count: 0,
};

test("sessionMark prioritizes attention, work, unread", () => {
  expect(sessionMark({ ...session, attention_required: true, active_turn_state: "thinking" })).toBe("attention");
  expect(sessionMark({ ...session, active_turn_state: "thinking" })).toBe("working");
  expect(sessionMark({ ...session, running_delegated_work: true })).toBe("working");
  expect(sessionMark(session)).toBe("unread");
});

test("sessionSubtitle covers status, progress and location", () => {
  const copy = { working: "Working", needsAttention: "Needs attention" };
  const idle = { ...session, unread: false };
  expect(sessionSubtitle({ ...idle, active_turn_state: "thinking", safe_status_label: "Reading files", work_progress: { completed: 2, total: 5 } }, "Desk", copy)).toBe("Reading files · 2/5");
  expect(sessionSubtitle({ ...idle, attention_required: true }, "Desk", copy)).toBe("Needs attention");
  expect(sessionSubtitle({ ...idle, branch: "feature/sample" }, "Desk", copy)).toBe("Desk · feature/sample");
  expect(sessionSubtitle({ ...idle, computer_name: "Studio" }, "Desk", copy)).toBe("Studio");
});

test("titleFromPrompt shortens a long first line and falls back for empty text", () => {
  expect(titleFromPrompt("  A   long first line that continues beyond forty-eight characters\nSecond line", "New chat"))
    .toBe("A long first line that continues beyond forty...");
  expect(titleFromPrompt(" \n ", "New chat")).toBe("New chat");
});
