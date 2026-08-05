/// <reference types="bun" />

import { afterEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { setAppCopyLanguage } from "@/app/copy.ts";
import type { SessionSummaryView } from "@/app/types.ts";

const storeState: { summary: SessionSummaryView | null } = { summary: null };

mock.module("@/app/store.ts", () => ({
  useButlerStore<T>(selector: (state: typeof storeState) => T): T {
    return selector(storeState);
  },
}));

afterEach(() => {
  storeState.summary = null;
  setAppCopyLanguage("en-US");
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("Git installation guidance appears only for the missing capability", async () => {
  const { shouldShowGitDependencyNotice } = await importNoticeModule();
  expect(shouldShowGitDependencyNotice({
      branch_info: { safe_error_code: "git_not_installed" },
    } as SessionSummaryView)).toBe(true);

  expect(shouldShowGitDependencyNotice({
      branch_info: { safe_error_code: "git_workspace_unavailable" },
    } as SessionSummaryView)).toBe(false);
  expect(shouldShowGitDependencyNotice(null)).toBe(false);
});

test("dismissal hides the notice without changing the missing-Git summary", async () => {
  const { GitDependencyNotice } = await importNoticeModule();
  storeState.summary = {
    branch_info: { safe_error_code: "git_not_installed" },
  } as SessionSummaryView;
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  const root = createRoot(container);
  setAppCopyLanguage("ko-KR");
  await act(async () => root.render(<GitDependencyNotice />));
  const close = container.querySelector(
    'button[aria-label="Git 안내 닫기"]',
  );
  if (!(close instanceof dom.window.HTMLButtonElement)) {
    throw new Error("Missing dismiss button.");
  }
  expect(container.textContent).toContain("설치되어 있지 않습니다");
  await act(async () => close.click());
  expect(container.textContent).not.toContain("설치되어 있지 않습니다");
  expect(storeState.summary?.branch_info?.safe_error_code).toBe(
    "git_not_installed",
  );
  await act(async () => root.unmount());

  const remountedRoot = createRoot(container);
  await act(async () => remountedRoot.render(<GitDependencyNotice />));
  expect(container.textContent).not.toContain("설치되어 있지 않습니다");
  expect(storeState.summary?.branch_info?.safe_error_code).toBe(
    "git_not_installed",
  );
  await act(async () => remountedRoot.unmount());
});

test("storage failures do not prevent notice rendering or dismissal", async () => {
  const { GitDependencyNotice } = await importNoticeModule();
  storeState.summary = {
    branch_info: { safe_error_code: "git_not_installed" },
  } as SessionSummaryView;
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  Object.defineProperty(dom.window, "sessionStorage", {
    configurable: true,
    get() {
      throw new Error("session storage unavailable");
    },
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  const root = createRoot(container);
  setAppCopyLanguage("ko-KR");
  await act(async () => root.render(<GitDependencyNotice />));
  expect(container.textContent).toContain("설치되어 있지 않습니다");
  const close = container.querySelector(
    'button[aria-label="Git 안내 닫기"]',
  );
  if (!(close instanceof dom.window.HTMLButtonElement)) {
    throw new Error("Missing dismiss button.");
  }
  await act(async () => close.click());
  expect(container.textContent).not.toContain("설치되어 있지 않습니다");
  expect(storeState.summary?.branch_info?.safe_error_code).toBe(
    "git_not_installed",
  );
  await act(async () => root.unmount());
});

async function importNoticeModule() {
  return await import("./GitDependencyNotice");
}
