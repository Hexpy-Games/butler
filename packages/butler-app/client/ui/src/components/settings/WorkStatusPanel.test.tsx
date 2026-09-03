/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkStatusView } from "@/app/types.ts";
import { WorkStatusPanel } from "./WorkStatusPanel";

let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

test("work status panel renders empty state and navigates without showing session identity", async () => {
  const window = installDom();
  const container = window.document.getElementById("root")!;
  root = createRoot(container);
  const opened: string[] = [];
  await act(async () => root?.render(
    <WorkStatusPanel view={emptyView()} onOpenSession={(id) => opened.push(id)} />,
  ));
  expect(container.querySelector('[data-testid="work-status-empty"]')).not.toBeNull();

  await act(async () => root?.render(
    <WorkStatusPanel view={populatedView()} onOpenSession={(id) => opened.push(id)} />,
  ));
  expect(container.textContent).toContain("Safe work title");
  expect(container.textContent).toContain("2/3");
  expect(container.textContent).not.toContain("session-private-123");
  (container.querySelector("button") as HTMLButtonElement).click();
  expect(opened).toEqual(["session-private-123"]);
});

function installDom(): Window {
  const window = new JSDOM("<!doctype html><div id='root'></div>").window;
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return window as unknown as Window;
}

function emptyView(): WorkStatusView {
  return {
    items: [],
    counts: {
      running: 0, completed: 0, attention: 0,
      operational_action: 0, operational_interruption: 0,
    },
  };
}

function populatedView(): WorkStatusView {
  return {
    items: [{
      session_id: "session-private-123",
      safe_title: "Safe work title",
      safe_summary: "Reviewing the current result.",
      state: "running",
      stage: "review",
      completed_actions: 2,
      total_actions: 3,
      effect_count: 1,
      updated_at: "2026-09-04T00:00:00.000Z",
    }],
    counts: {
      running: 1, completed: 0, attention: 0,
      operational_action: 0, operational_interruption: 0,
    },
  };
}
