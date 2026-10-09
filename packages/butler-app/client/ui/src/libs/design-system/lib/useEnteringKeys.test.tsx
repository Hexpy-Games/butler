// test-category: pure-logic
/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useEnteringKeys } from "./useEnteringKeys";

const GLOBAL_KEYS = ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"];
const saved = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
let root: Root | null = null;
let entering = new Set<string>();

function Probe({ keys, scope, enterOnScopeChange }: { keys: string[]; scope: string; enterOnScopeChange?: (key: string) => boolean }) {
  entering = useEnteringKeys(keys, scope, { enterOnScopeChange });
  return null;
}

function setup() {
  const dom = new JSDOM('<div id="root"></div>');
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
  });
  root = createRoot(dom.window.document.getElementById("root")!);
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test("keys present at first render or after a scope change do not enter", async () => {
  setup();
  await act(async () => root!.render(<Probe keys={["a", "b"]} scope="chat-1" />));
  expect([...entering]).toEqual([]);
  await act(async () => root!.render(<Probe keys={["a", "b", "c"]} scope="chat-1" />));
  expect([...entering]).toEqual(["c"]);
  await act(async () => root!.render(<Probe keys={["x", "y"]} scope="chat-2" />));
  expect([...entering]).toEqual([]);
});

test("a scope change can still enter keys the caller marks as just sent", async () => {
  setup();
  await act(async () => root!.render(<Probe keys={[]} scope="draft" />));
  await act(async () => root!.render(<Probe keys={["sent"]} scope="chat-3" enterOnScopeChange={(key) => key === "sent"} />));
  expect([...entering]).toEqual(["sent"]);
});
