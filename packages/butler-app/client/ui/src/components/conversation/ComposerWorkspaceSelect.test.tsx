import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ComposerWorkspaceSelect } from "./ComposerWorkspaceSelect.tsx";
import { useComposerStore } from "./composerStore.ts";
import { projectDraftId } from "@/app/utils.ts";

test("both new conversation surfaces reuse glass capsules, default to local, and lock during send", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const state = useComposerStore.getState();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const container = dom.window.document.querySelector("#root")!;
  const root = createRoot(container);
  try {
    for (const draftId of [projectDraftId("project-one"), "dashboard:project-one"]) {
      await act(async () => {
        useComposerStore.getState().activateDraftSession(draftId, "");
        useComposerStore.setState({ isSending: false });
        root.render(<ComposerWorkspaceSelect />);
      });
      const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
      expect(trigger.textContent).toBe("Local");
      expect(trigger.dataset.surface).toBe("glass-pill");
      expect(trigger.querySelector("svg")).not.toBeNull();
      await act(async () => { useComposerStore.getState().setWorkspaceMode("worktree"); });
      expect(useComposerStore.getState().workspaceMode).toBe("worktree");
      expect(trigger.textContent).toBe("Worktree");
      await act(async () => useComposerStore.setState({ isSending: true }));
      expect(trigger.disabled).toBe(true);
    }
    await act(async () => {
      useComposerStore.getState().activateDraftSession("draft:chat", "");
      useComposerStore.setState({ isSending: false });
    });
    const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    expect(trigger.textContent).toBe("Local");
    await act(async () => { useComposerStore.getState().activateDraftSession("existing-session", ""); });
    expect(container.querySelector('[role="combobox"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    useComposerStore.setState(state);
    globals.forEach((key, index) => {
      if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!);
      else Reflect.deleteProperty(globalThis, key);
    });
    dom.window.close();
  }
});
