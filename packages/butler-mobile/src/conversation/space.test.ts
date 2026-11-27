// test-category: pure-logic
import { expect, test } from "bun:test";
import type { EpicCard, NavigationView, SessionSummary } from "../../../butler-protocol/src/index.ts";
import { recentRows, spaceTree, visibleRows, withCanon } from "./space";

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

test("recentRows flattens a canon tree to its sessions, newest first, General included", () => {
  const at = (id: string, last_activity_at: string, extra?: Partial<SessionSummary>): SessionSummary => ({
    id, kind: "chat", title: id, session_hint: "", created_at: last_activity_at, updated_at: last_activity_at,
    last_activity_at, unread: false, pinned: false, archived: false, automation_target_count: 0, ...extra,
  });
  const view: NavigationView = {
    chats: [at("general", "09:00"), at("old", "10:00"), at("b", "12:00"), at("a", "12:00")],
    projects: [{ id: "project", display_name: "Project", status: "active", last_activity_at: "11:00",
      active_session_count: 1, pinned: false, archived: false, workspace_label: "", safe_path_label: "",
      sessions: [at("nested", "11:00", { project_id: "project" })] }],
    space: { revision: 0, groups: [], nodes: [{ key: "p:project", kind: "project", entityId: "project",
      parentKey: null, position: 0, revision: 0, manualPlacement: false, scopeProjectId: null }] },
    automations_summary: { total_count: 0, enabled_count: 0 }, settings_summary: { profile_label: "" }, generated_at: "12:00",
  };
  const epic = { id: "epic", title: "Epic", home_session_id: null, sessions: [{ session_id: "nested", worked: 1 }] } as unknown as EpicCard;
  const tree = withCanon(spaceTree(view), new Map([["project", {
    project_id: "project", groups: [{ key: "backlog", kind: "backlog", title: "", rows: [epic] }],
  }]]), "Backlog");
  expect(recentRows(tree, "General").map(r => [r.key, r.session!.title])).toEqual([
    ["s:a", "a"], ["s:b", "b"], ["s:nested", "nested"], ["s:old", "old"], ["s:general", "General"],
  ]);
});
