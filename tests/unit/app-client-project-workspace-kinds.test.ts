import { afterEach, expect, test } from "bun:test";
import {
  learnProjectWorkspaceKinds,
  readCachedProjectWorkspaceKinds,
  reportedGitRepo,
  resolveGitProject,
  writeCachedProjectWorkspaceKinds,
} from "../../packages/butler-app/client/ui/src/app/projectWorkspaceKinds.ts";
import { selectIsGitProject, useButlerStore } from "../../packages/butler-app/client/ui/src/app/store.ts";
import type { ProjectSummary, SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";

const initialState = useButlerStore.getState();
const savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

afterEach(() => {
  useButlerStore.setState(initialState, true);
  if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

function installStorage(): Map<string, string> {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  });
  return values;
}

function projectView(
  sessionId: string,
  projectId: string | undefined,
  workspaceMode: "git" | "folder" | "none" | "unknown",
): SessionView {
  return {
    session_id: sessionId,
    kind: projectId ? "project" : "chat",
    ...(projectId ? { project_id: projectId } : {}),
    status: "idle",
    active_turn: null,
    latest_turn: null,
    messages: [],
    message_window: { next_cursor: null },
    workers: [],
    work_streams: [],
    artifacts: [],
    context: null,
    branch: { workspace_mode: workspaceMode },
    automations: [],
    errors: [],
    cursors: { messages: 0 },
  } as unknown as SessionView;
}

test("project workspace kinds are learned only from definite project session views", () => {
  const known = learnProjectWorkspaceKinds({}, [
    projectView("a", "git-project", "git"),
    projectView("b", "folder-project", "folder"),
    projectView("c", "unknown-project", "unknown"),
    projectView("d", undefined, "git"),
  ]);
  expect(known).toEqual({ "git-project": "git", "folder-project": "folder" });
  expect(learnProjectWorkspaceKinds(known, [projectView("e", "git-project", "git")])).toBe(known);
  expect(learnProjectWorkspaceKinds(known, [projectView("f", "folder-project", "git")])).toEqual({
    "git-project": "git",
    "folder-project": "git",
  });
});

test("project workspace kinds survive a restart through the local cache", () => {
  installStorage();
  expect(readCachedProjectWorkspaceKinds()).toEqual({});
  writeCachedProjectWorkspaceKinds({ "git-project": "git" });
  expect(readCachedProjectWorkspaceKinds()).toEqual({ "git-project": "git" });
});

test("loading a project session view marks its project as Git for new chats", () => {
  const storage = installStorage();
  expect(selectIsGitProject("git-project")(useButlerStore.getState())).toBe(false);
  useButlerStore.getState().setSessionView(projectView("session-a", "git-project", "git"));
  expect(selectIsGitProject("git-project")(useButlerStore.getState())).toBe(true);
  expect(selectIsGitProject("other-project")(useButlerStore.getState())).toBe(false);
  expect(selectIsGitProject(undefined)(useButlerStore.getState())).toBe(false);
  expect(JSON.parse([...storage.values()][0] ?? "{}")).toMatchObject({
    kinds: { "git-project": "git" },
  });
});

function listedProject(id: string, git?: ProjectSummary["git"]): ProjectSummary {
  return {
    id,
    display_name: id,
    last_activity_at: "2026-09-28T00:00:00Z",
    pinned: false,
    archived: false,
    ...(git === undefined ? {} : { git }),
  };
}

function listProjects(...projects: ProjectSummary[]) {
  useButlerStore.getState().setNavigation({ ...useButlerStore.getState().navigation, projects });
}

test("git.is_repo on the project list decides over what sessions reported", () => {
  installStorage();
  useButlerStore.setState({ projectWorkspaceKinds: { repo: "folder", plain: "git" } });
  listProjects(
    listedProject("repo", { is_repo: true, branch: "main", dirty: null, ahead: null, behind: null }),
    listedProject("plain", { is_repo: false, branch: null, dirty: null, ahead: null, behind: null }),
  );
  expect(selectIsGitProject("repo")(useButlerStore.getState())).toBe(true);
  expect(selectIsGitProject("plain")(useButlerStore.getState())).toBe(false);
});

test("an older agent sends no git, so the learned session kind still decides", () => {
  installStorage();
  useButlerStore.setState({ projectWorkspaceKinds: { "old-repo": "git", "old-plain": "folder" } });
  listProjects(listedProject("old-repo"), listedProject("old-plain", null));
  expect(selectIsGitProject("old-repo")(useButlerStore.getState())).toBe(true);
  expect(selectIsGitProject("old-plain")(useButlerStore.getState())).toBe(false);
  expect(selectIsGitProject("unlisted")(useButlerStore.getState())).toBe(false);
});

// test-category: pure-logic
test("project Git sources resolve in order: dashboard, list, then learned sessions", () => {
  expect(reportedGitRepo(undefined)).toBeUndefined();
  expect(reportedGitRepo({ git: null })).toBeUndefined();
  expect(reportedGitRepo({ git: { is_repo: false, branch: null } })).toBe(false);
  expect(resolveGitProject({ dashboard: false, listed: true, learned: "git" })).toBe(false);
  expect(resolveGitProject({ listed: false, learned: "git" })).toBe(false);
  expect(resolveGitProject({ learned: "git" })).toBe(true);
  expect(resolveGitProject({ learned: "folder" })).toBe(false);
  expect(resolveGitProject({})).toBe(false);
});
