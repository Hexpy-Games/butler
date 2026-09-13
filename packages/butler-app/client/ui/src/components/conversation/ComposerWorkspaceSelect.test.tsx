import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ComposerWorkspaceSelect } from "./ComposerWorkspaceSelect.tsx";
import { useComposerStore } from "./composerStore.ts";
import { projectDraftId } from "@/app/utils.ts";

test("both new conversation surfaces default to local, allow worktree, and lock during send", async () => {
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
      const select = container.querySelector("select")!;
      expect(select.value).toBe("local");
      await act(async () => {
        select.value = "worktree";
        select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
      expect(useComposerStore.getState().workspaceMode).toBe("worktree");
      expect(select.value).toBe("worktree");
      await act(async () => useComposerStore.setState({ isSending: true }));
      expect(select.disabled).toBe(true);
    }
    await act(async () => {
      useComposerStore.getState().activateDraftSession("draft:chat", "");
      useComposerStore.setState({ isSending: false });
    });
    expect(container.querySelector("select")!.value).toBe("local");
    expect(container.querySelector<HTMLOptionElement>('option[value="worktree"]')!.disabled).toBe(true);
    await act(async () => { useComposerStore.getState().activateDraftSession("existing-session", ""); });
    expect(container.querySelector("select")).toBeNull();
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
