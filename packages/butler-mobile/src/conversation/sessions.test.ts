// test-category: pure-logic
import { expect, test } from "bun:test";
import type { NavigationView, SessionSummary } from "../../../butler-protocol/src/index.ts";
import { conversationSections, sessionMark } from "./sessions";

test("conversationSections drops archives and orders activity; sessionMark prioritizes attention, work, unread", () => {
  const session: SessionSummary = {
    id: "old", kind: "chat", title: "Old", session_hint: "", created_at: "2026-11-18T10:00:00Z",
    updated_at: "2026-11-18T10:00:00Z", last_activity_at: "2026-11-18T10:00:00Z",
    unread: true, pinned: false, archived: false, automation_target_count: 0,
  };
  const newer = { ...session, id: "new", last_activity_at: "2026-11-19T10:00:00Z" };
  const project = { id: "old-project", display_name: "Old project", status: "active" as const,
    last_activity_at: session.last_activity_at, active_session_count: 1, pinned: false,
    archived: false, workspace_label: "", safe_path_label: "", sessions: [session] };
  const view: NavigationView = {
    space: { revision: 0, nodes: [], groups: [] },
    chats: [session, { ...session, id: "archived", archived: true }, newer],
    projects: [project, { ...project, id: "new-project", display_name: "New project", sessions: [session, newer] },
      { ...project, id: "archived-project", archived: true },
      { ...project, id: "only-archived", sessions: [{ ...session, archived: true }] }],
    automations_summary: { total_count: 0, enabled_count: 0 }, settings_summary: { profile_label: "" }, generated_at: "2026-11-19T10:00:00Z",
  };
  expect(conversationSections(view, "Conversations").map(s => ({ key: s.key, title: s.title, ids: s.data.map(item => item.id) }))).toEqual([
    { key: "general", title: "Conversations", ids: ["new", "old"] },
    { key: "new-project", title: "New project", ids: ["new", "old"] },
    { key: "old-project", title: "Old project", ids: ["old"] },
  ]);
  expect(sessionMark({ ...session, attention_required: true, active_turn_state: "thinking" })).toBe("attention");
  expect(sessionMark({ ...session, active_turn_state: "thinking" })).toBe("working");
  expect(sessionMark({ ...session, running_delegated_work: true })).toBe("working");
  expect(sessionMark(session)).toBe("unread");
});
