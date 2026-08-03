/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { WorkBlockView } from "@/app/types.ts";
import { CollapsedTurnActivity } from "./WorkBlocks";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("work activity shows only the latest block until view all expands", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", {
    url: "http://localhost",
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
  await act(async () => {
    root.render(
      <CollapsedTurnActivity
        blocks={[
          workBlock("first", "이전 활동"),
          workBlock("latest", "가장 최신 활동"),
        ]}
      />,
    );
  });

  expect(container.textContent).not.toContain("이전 활동");
  expect(container.textContent).toContain("가장 최신 활동");
  const toggle = container.querySelector(
    '[data-test-class="toggle-turn-activity-history"]',
  );
  if (!(toggle instanceof dom.window.HTMLButtonElement)) {
    throw new Error("Missing activity history toggle.");
  }
  expect(toggle.textContent).toContain("전체 보기 (2)");

  await act(async () => toggle.click());

  expect(container.textContent).toContain("이전 활동");
  expect(container.textContent).toContain("가장 최신 활동");
  expect(toggle.textContent).toContain("접기");
  await act(async () => root.unmount());
});

test("completed work keeps its turn identity for lazy operation output", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", {
    url: "http://localhost",
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
  await act(async () => {
    root.render(
      <CollapsedTurnActivity
        blocks={[{
          ...workBlock("operation", "검토한 작업"),
          rows: [{
            id: "operation-row",
            kind: "used_tool",
            state: "completed",
            safe_label: "실행: git commit",
            safe_tool_name: "run_command",
            tool_call_id: "request-1",
            tool_result_id: "result-1",
            bridge_phase: "btcc_operation",
          }],
        }]}
        turnId="turn-1"
      />,
    );
  });

  expect(container.textContent).toContain("실행: git commit");
  const toolButton = container.querySelector(
    '[data-test-class~="turn-work-tool-row"] button',
  );
  expect(toolButton).not.toBeNull();
  await act(async () => root.unmount());
});

test("live legacy activity rolls while completed history stays still", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", {
    url: "http://localhost",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = dom.window.document.querySelector("#root")!;
  const root = createRoot(container);
  const first = workBlock("first", "이전 활동");

  await act(async () => root.render(
    <CollapsedTurnActivity blocks={[first]} live />,
  ));
  await act(async () => root.render(
    <CollapsedTurnActivity
      blocks={[first, workBlock("latest", "최신 활동")]}
      live
    />,
  ));
  expect(container.querySelector('[data-motion="outgoing"]')?.textContent)
    .toContain("이전 활동");

  await act(async () => root.render(
    <CollapsedTurnActivity
      blocks={[first, workBlock("completed", "완료 기록")]}
    />,
  ));
  expect(container.querySelector('[data-motion="outgoing"]')).toBeNull();
  expect(container.textContent).toContain("완료 기록");
  await act(async () => root.unmount());
});

function workBlock(id: string, label: string): WorkBlockView {
  return {
    id,
    label,
    state: "running",
    rows: [],
  };
}
