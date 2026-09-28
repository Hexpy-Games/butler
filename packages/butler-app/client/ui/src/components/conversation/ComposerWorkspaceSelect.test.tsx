import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ComposerWorkspaceSelect } from "./ComposerWorkspaceSelect.tsx";
import { useComposerStore } from "./composerStore.ts";
import { useButlerStore } from "@/app/store.ts";
import { projectDraftId } from "@/app/utils.ts";

async function withRoot(run: (container: Element, render: (draftId: string) => Promise<void>) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = ["window", "document", "navigator", "HTMLElement", "DocumentFragment", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const composerState = useComposerStore.getState();
  const butlerState = useButlerStore.getState();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    DocumentFragment: dom.window.DocumentFragment, IS_REACT_ACT_ENVIRONMENT: true });
  const container = dom.window.document.querySelector("#root")!;
  const root = createRoot(container);
  const render = async (draftId: string) => {
    await act(async () => {
      useComposerStore.getState().activateDraftSession(draftId, "");
      useComposerStore.setState({ isSending: false });
      root.render(<ComposerWorkspaceSelect />);
    });
  };
  try {
    await run(container, render);
  } finally {
    await act(async () => root.unmount());
    useComposerStore.setState(composerState);
    useButlerStore.setState(butlerState, true);
    globals.forEach((key, index) => {
      if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!);
      else Reflect.deleteProperty(globalThis, key);
    });
    dom.window.close();
  }
}

test("Git projects use the composer control style, default to local, and lock during send", async () => {
  await withRoot(async (container, render) => {
    useButlerStore.setState({ projectWorkspaceKinds: { "project-one": "git" } });
    for (const draftId of [projectDraftId("project-one"), "dashboard:project-one"]) {
      await render(draftId);
      const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
      expect(trigger.textContent).toBe("Local");
      // Same control style as the access-mode control beside it, not a glass pill.
      expect(trigger.dataset.surface).toBeUndefined();
      expect(trigger.querySelector('[data-test-class="composer-control-content"]')).not.toBeNull();
      expect(trigger.querySelector("svg")).not.toBeNull();
      await act(async () => { useComposerStore.getState().setWorkspaceMode("worktree"); });
      expect(useComposerStore.getState().workspaceMode).toBe("worktree");
      expect(trigger.textContent).toBe("Worktree");
      await act(async () => useComposerStore.setState({ isSending: true }));
      expect(trigger.disabled).toBe(true);
    }
  });
});

function listProjects(projects: Array<{ id: string; is_repo?: boolean }>) {
  useButlerStore.getState().setNavigation({
    ...useButlerStore.getState().navigation,
    projects: projects.map(({ id, is_repo }) => ({
      id, display_name: id, last_activity_at: "2026-09-28T00:00:00Z", pinned: false, archived: false,
      ...(is_repo === undefined ? {} : { git: { is_repo, branch: is_repo ? "main" : null } }),
    })),
  });
}

test("git.is_repo from the project list shows or hides the picker, whatever sessions reported", async () => {
  await withRoot(async (container, render) => {
    useButlerStore.setState({ projectWorkspaceKinds: { "listed-repo": "folder", "listed-plain": "git" } });
    listProjects([{ id: "listed-repo", is_repo: true }, { id: "listed-plain", is_repo: false }]);
    await render(projectDraftId("listed-repo"));
    expect(container.querySelector('[role="combobox"]')?.textContent).toBe("Local");
    for (const draftId of [projectDraftId("listed-plain"), "dashboard:listed-plain"]) {
      await render(draftId);
      expect(container.querySelector('[role="combobox"]'), draftId).toBeNull();
    }
  });
});

test("an older agent without git falls back to the kind learned from sessions", async () => {
  await withRoot(async (container, render) => {
    useButlerStore.setState({ projectWorkspaceKinds: { "old-repo": "git" } });
    listProjects([{ id: "old-repo" }]);
    await render("dashboard:old-repo");
    expect(container.querySelector('[role="combobox"]')).not.toBeNull();
  });
});

test("the picker stays hidden outside Git projects", async () => {
  await withRoot(async (container, render) => {
    useButlerStore.setState({ projectWorkspaceKinds: { "folder-project": "folder" } });
    for (const draftId of [
      "draft:chat",
      projectDraftId("folder-project"),
      "dashboard:folder-project",
      projectDraftId("unknown-project"),
      "existing-session",
    ]) {
      await render(draftId);
      expect(container.querySelector('[role="combobox"]'), draftId).toBeNull();
    }
  });
});
