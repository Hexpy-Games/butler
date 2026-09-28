/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { ProgressRow } from "@/app/types.ts";
import { heldMorphKeys } from "@/libs/design-system/components/ButlerThinkingMark/morphContinuity.ts";
import { TurnActivityPanel } from "./TurnActivityPanel";

const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"] as const;

afterEach(() => {
  for (const key of GLOBALS) delete (globalThis as Record<string, unknown>)[key];
});

const runningTool: ProgressRow = {
  id: "tool-row",
  kind: "ran_command",
  state: "running",
  safe_label: "Bun: app-client utils",
  safe_tool_name: "Bun",
  safe_input_label: "app-client utils",
  tool_call_id: "tool-test",
};

test("the status mark keeps one morph when pending turns into the current status (no restart from the logo)", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", { url: "http://localhost" });
  // jsdom has no 2D canvas: the mark holds its morph but draws nothing, which is all this checks.
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const before = new Set(heldMorphKeys());
  await act(async () => root.render(<TurnActivityPanel rows={[]} state="running" />));
  const pendingMark = dom.window.document.querySelector("[data-mark-state=working]");
  const pendingKeys = heldMorphKeys().filter((key) => !before.has(key));
  expect(pendingMark).not.toBeNull();
  expect(pendingKeys).toHaveLength(1);

  await act(async () => root.render(<TurnActivityPanel rows={[runningTool]} state="running" />));
  const currentMark = dom.window.document.querySelector("[data-mark-state=working]");
  // the tree changed, so the mark element is new...
  expect(dom.window.document.querySelector("[data-test-class~=turn-current-status-slot]")).not.toBeNull();
  expect(currentMark).not.toBe(pendingMark);
  // ...but it holds the same morph key, so it continues the pending mark's morph.
  expect(heldMorphKeys().filter((key) => !before.has(key))).toEqual(pendingKeys);

  await act(async () => root.unmount());
  await Promise.resolve();
  expect(heldMorphKeys().filter((key) => !before.has(key))).toEqual([]);
});
