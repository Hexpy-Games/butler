/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { selectActiveChat, selectViewTitle, useButlerStore } from "@/app/store.ts";
import type { NavigationView, SessionSummary } from "@/app/types.ts";
import { Titlebar } from "./Titlebar.tsx";

let root: Root | undefined;
const initialStoreState = useButlerStore.getState();

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
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
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
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
