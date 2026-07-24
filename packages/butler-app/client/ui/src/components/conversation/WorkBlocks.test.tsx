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

function workBlock(id: string, label: string): WorkBlockView {
  return {
    id,
    label,
    state: "running",
    rows: [],
  };
}
