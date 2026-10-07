// test-category: race
/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useQueuedDeliveries } from "./useQueuedDeliveries";

const GLOBAL_KEYS = ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"] as const;
const saved = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
let root: Root | null = null;
let wasQueued: (id: string) => boolean = () => false;

function Probe({ keys, chat }: { keys: string[]; chat: string }) {
  wasQueued = useQueuedDeliveries(keys, chat);
  return null;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test("messages whose id was shown as a queued row are recognized after the row leaves the queue", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
  });
  root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root!.render(<Probe keys={["client-1", "client-2"]} chat="chat-a" />));
  await act(async () => root!.render(<Probe keys={["client-2"]} chat="chat-a" />));
  expect(wasQueued("client-1")).toBe(true);
  expect(wasQueued("client-2")).toBe(true);
  expect(wasQueued("other")).toBe(false);
  await act(async () => root!.render(<Probe keys={[]} chat="chat-b" />));
  expect(wasQueued("client-1")).toBe(false);
});
