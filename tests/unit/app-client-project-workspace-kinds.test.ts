import { afterEach, expect, test } from "bun:test";
import {
  learnProjectWorkspaceKinds,
  readCachedProjectWorkspaceKinds,
  writeCachedProjectWorkspaceKinds,
} from "../../packages/butler-app/client/ui/src/app/projectWorkspaceKinds.ts";
import { selectIsGitProject, useButlerStore } from "../../packages/butler-app/client/ui/src/app/store.ts";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";

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
