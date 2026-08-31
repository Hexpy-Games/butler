/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { appCopy } from "@/app/copy.ts";
import { selectActiveChat, selectViewTitle, useButlerStore } from "@/app/store.ts";
import type { NavigationView, SessionSummary } from "@/app/types.ts";

let root: Root | undefined;
const initialStoreState = useButlerStore.getState();

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  await new Promise((resolve) => setTimeout(resolve, 0));
  useButlerStore.setState({
    navigation: initialStoreState.navigation,
    view: initialStoreState.view,
    activeChatId: initialStoreState.activeChatId,
    leftOpen: initialStoreState.leftOpen,
    rightOpen: initialStoreState.rightOpen,
    summary: initialStoreState.summary,
  });
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { Element?: unknown }).Element;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { HTMLButtonElement?: unknown }).HTMLButtonElement;
  delete (globalThis as { SVGElement?: unknown }).SVGElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { DocumentFragment?: unknown }).DocumentFragment;
  delete (globalThis as { Event?: unknown }).Event;
  delete (globalThis as { CustomEvent?: unknown }).CustomEvent;
  delete (globalThis as { MouseEvent?: unknown }).MouseEvent;
  delete (globalThis as { KeyboardEvent?: unknown }).KeyboardEvent;
  delete (globalThis as { FocusEvent?: unknown }).FocusEvent;
  delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
  delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("active session worktree is visible in the titlebar without exposing a path", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { Titlebar } = await import("./Titlebar.tsx");
  useButlerStore.setState({
    view: { kind: "session" },
    activeChatId: "session-titlebar",
    navigation: navigation("Worktree session"),
    summary: {
      session_id: "session-titlebar",
      branch_info: {
        available: true,
        workspace_mode: "git",
        branch_name: "codex/worktree-visibility",
        safe_status: "Git branch codex/worktree-visibility",
        workspace_binding: "session_worktree",
        workspace_label: "session-worktree/codex/worktree-visibility",
        workspace_status: "available",
        dirty: false,
      },
    },
    leftOpen: true,
    rightOpen: false,
  });
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) throw new Error("Missing root.");
  root = createRoot(container);
  await act(async () => root?.render(<Titlebar />));

  const indicator = container.querySelector(
    '[data-test-class="titlebar-workspace"]',
  );
  expect(indicator?.textContent).toContain("codex/worktree-visibility");
  expect(indicator?.getAttribute("aria-label")).toContain("worktree");
  expect(container.innerHTML).not.toContain("/Users/");
});

test("titlebar ellipsis opens the session-folder submenu and launches the selected target", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", { url: "http://localhost" });
  const ResizeObserverStub = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const targetInputs: unknown[] = [];
  const openInputs: unknown[] = [];
  Object.assign(dom.window, {
    butlerApp: {
      getSessionFolderLaunchTargets: async (input: unknown) => {
        targetInputs.push(input);
        return { ok: true, targets: ["vscode", "terminal"] };
      },
      openSessionFolder: async (input: unknown) => {
        openInputs.push(input);
        return { ok: true, target: (input as { target: string }).target };
      },
    },
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    SVGElement: dom.window.SVGElement,
    Node: dom.window.Node,
    DocumentFragment: dom.window.DocumentFragment,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    FocusEvent: dom.window.FocusEvent,
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: ResizeObserverStub,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { Titlebar } = await import("./Titlebar.tsx");
  useButlerStore.setState({
    view: { kind: "session" },
    activeChatId: "session-titlebar",
    navigation: navigation("Open folder session"),
    summary: {
      session_id: "session-titlebar",
      branch_info: {
        available: true,
        workspace_mode: "git",
        branch_name: "codex/session-folder",
        safe_status: "Git branch codex/session-folder",
        workspace_binding: "session_worktree",
        workspace_label: "session-worktree/codex/session-folder",
        workspace_status: "available",
        dirty: false,
      },
    },
    leftOpen: true,
    rightOpen: false,
  });
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) throw new Error("Missing root.");
  root = createRoot(container);
  await act(async () => root?.render(<Titlebar />));

  const menuButton = container.querySelector(
    '[data-slot="dropdown-menu-trigger"]',
  );
  if (!(menuButton instanceof dom.window.HTMLElement)) throw new Error("Missing session menu.");
  await act(async () => {
    menuButton.focus();
    menuButton.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const submenuTrigger = dom.window.document.querySelector(
    '[data-slot="dropdown-menu-sub-trigger"]',
  );
  if (!(submenuTrigger instanceof dom.window.HTMLElement)) {
    throw new Error("Missing session-folder submenu.");
  }
  expect(submenuTrigger.textContent).toContain(
    appCopy.sessionActions.openSessionFolder,
  );
  await act(async () => {
    submenuTrigger.focus();
    submenuTrigger.dispatchEvent(new dom.window.MouseEvent("click", {
      bubbles: true,
      button: 0,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(targetInputs).toEqual([{ sessionId: "session-titlebar" }]);
  const submenuContent = dom.window.document.querySelector(
    '[data-slot="dropdown-menu-sub-content"]',
  );
  const menuContent = dom.window.document.querySelector(
    '[data-slot="dropdown-menu-content"]',
  );
  expect(menuContent?.contains(submenuContent)).toBe(false);
  expect(submenuContent?.textContent).toContain(appCopy.sessionActions.vsCode);
  expect(submenuContent?.textContent).toContain(appCopy.sessionActions.terminal);
  const vscodeItem = Array.from(
    dom.window.document.querySelectorAll('[data-slot="dropdown-menu-item"]'),
  ).find((item) => item.textContent?.includes("VS Code"));
  if (!(vscodeItem instanceof dom.window.HTMLElement)) throw new Error("Missing VS Code target.");
  await act(async () => {
    vscodeItem.dispatchEvent(
      new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    vscodeItem.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true, button: 0 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(openInputs).toEqual([{
    sessionId: "session-titlebar",
    target: "vscode",
  }]);
  expect(JSON.stringify(openInputs)).not.toContain("/");
});

test("local project workspace and its Git branch stay visible in the titlebar", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { Titlebar } = await import("./Titlebar.tsx");
  useButlerStore.setState({
    view: { kind: "session" },
    activeChatId: "session-titlebar",
    navigation: navigation("Local session"),
    summary: {
      session_id: "session-titlebar",
      branch_info: {
        available: true,
        workspace_mode: "git",
        branch_name: "main",
        safe_status: "Git branch main",
        workspace_binding: "project",
        workspace_label: "Project workspace",
        workspace_status: "available",
        dirty: false,
      },
    },
    leftOpen: true,
    rightOpen: false,
  });
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) throw new Error("Missing root.");
  root = createRoot(container);
  await act(async () => root?.render(<Titlebar />));

  const indicator = container.querySelector(
    '[data-test-class="titlebar-workspace"]',
  );
  expect(indicator?.textContent).toBe("Local · main");
});

test("live navigation title updates the active titlebar and selectors without remount", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { Titlebar } = await import("./Titlebar.tsx");
  useButlerStore.setState({
    view: { kind: "session" },
    activeChatId: "session-titlebar",
    navigation: navigation("Prompt fallback"),
    leftOpen: true,
    rightOpen: false,
  });
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) throw new Error("Missing root.");
  root = createRoot(container);
  await act(async () => root?.render(<Titlebar />));
  expect(container.querySelector('[data-test-class="titlebar-title"]')?.textContent)
    .toBe("Prompt fallback");

  await act(async () => {
    useButlerStore.setState({ navigation: navigation("생성 제목") });
  });
  expect(container.querySelector('[data-test-class="titlebar-title"]')?.textContent)
    .toBe("생성 제목");
  const state = useButlerStore.getState();
  expect(selectActiveChat(state).shortTitle).toBe("생성 제목");
  expect(selectViewTitle(state).title).toBe("생성 제목");
});

function navigation(title: string): NavigationView {
  const session: SessionSummary = {
    id: "session-titlebar",
    kind: "project",
    project_id: "project-titlebar",
    title,
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:01:00.000Z",
    last_activity_at: "2026-08-08T00:01:00.000Z",
    pinned: false,
    archived: false,
  };
  return {
    chats: [],
    projects: [{
      id: "project-titlebar",
      display_name: "Titlebar project",
      last_activity_at: "2026-08-08T00:01:00.000Z",
      pinned: false,
      archived: false,
      sessions: [session],
    }],
    automations_summary: { total_count: 0, enabled_count: 0 },
    settings_summary: { profile_label: "Test" },
  };
}
