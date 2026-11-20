// test-category: pure-logic
import { expect, test } from "bun:test";
import type { NavigationView, SessionSummary } from "../../../butler-protocol/src/index.ts";
import { spaceTree, visibleRows } from "./space";

test("spaceTree projects live nodes in order and visibleRows collapses descendants", () => {
  const session: SessionSummary = {
    id: "root", kind: "chat", title: "Root", session_hint: "", created_at: "2026-11-18T10:00:00Z",
    updated_at: "2026-11-18T10:00:00Z", last_activity_at: "2026-11-18T10:00:00Z",
    unread: false, pinned: false, archived: false, automation_target_count: 0,
  };
  const project = { id: "project", display_name: "Project", status: "active" as const,
    last_activity_at: session.last_activity_at, active_session_count: 2, pinned: false,
    archived: false, workspace_label: "", safe_path_label: "",
    sessions: [{ ...session, id: "live" }, { ...session, id: "archived", archived: true }, { ...session, id: "nested" },
      { ...session, id: "unplaced-project", project_id: "project" }] };
  const view: NavigationView = {
    chats: [{ ...session, id: "general", title: "My conversation" }, session, { ...session, id: "unplaced-chat" }],
    projects: [project, { ...project, id: "old-project", archived: true, sessions: [{ ...session, id: "hidden" }] }],
    space: { revision: 0, groups: [{ id: "group", title: "Group", scopeProjectId: "project", origin: "manual" }],
      nodes: [
        { key: "p:project", kind: "project", entityId: "project", parentKey: null, position: 1 },
        { key: "s:root", kind: "session", entityId: "root", parentKey: null, position: 0 },
        { key: "s:live", kind: "session", entityId: "live", parentKey: "p:project", position: 0 },
        { key: "s:archived", kind: "session", entityId: "archived", parentKey: "p:project", position: 1 },
        { key: "g:group", kind: "group", entityId: "group", parentKey: "p:project", position: 2 },
        { key: "s:nested", kind: "session", entityId: "nested", parentKey: "g:group", position: 0 },
        { key: "p:old-project", kind: "project", entityId: "old-project", parentKey: null, position: 2 },
        { key: "s:hidden", kind: "session", entityId: "hidden", parentKey: "p:old-project", position: 0 },
      ].map(node => ({ ...node, kind: node.kind as "session" | "project" | "group", revision: 0, manualPlacement: false, scopeProjectId: null })) },
    automations_summary: { total_count: 0, enabled_count: 0 }, settings_summary: { profile_label: "" }, generated_at: session.created_at,
  };
  const tree = spaceTree(view);
  expect(tree.general?.title).toBe("My conversation");
  expect(visibleRows(tree, new Set()).map(row => [row.key, row.depth])).toEqual([
    ["s:root", 0], ["p:project", 0], ["s:live", 1], ["g:group", 1], ["s:nested", 2],
    ["s:unplaced-project", 1], ["s:unplaced-chat", 0],
  ]);
  expect(visibleRows(tree, new Set(["p:project"])).map(row => [row.key, row.depth])).toEqual([
    ["s:root", 0], ["p:project", 0], ["s:unplaced-chat", 0],
  ]);
});
