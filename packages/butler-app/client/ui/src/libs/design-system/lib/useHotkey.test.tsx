// test-category: security
/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { matchesHotkey, useHotkey } from "./useHotkey";

const key = (init: Partial<KeyboardEventInit> & { keyCode?: number; isComposing?: boolean }) =>
  ({ key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, keyCode: 75, ...init }) as unknown as KeyboardEvent;

test("mod means Cmd on macOS and Ctrl elsewhere; extra modifiers do not match", () => {
  expect(matchesHotkey(key({ metaKey: true }), "mod+k", "mac")).toBe(true);
  expect(matchesHotkey(key({ ctrlKey: true }), "mod+k", "mac")).toBe(false);
  expect(matchesHotkey(key({ ctrlKey: true }), "mod+k", "other")).toBe(true);
  expect(matchesHotkey(key({ metaKey: true }), "mod+k", "other")).toBe(false);
  expect(matchesHotkey(key({ metaKey: true, shiftKey: true }), "mod+k", "mac")).toBe(false);
  expect(matchesHotkey(key({ metaKey: true, key: "K" }), "mod+k", "mac")).toBe(true);
  expect(matchesHotkey(key({ key: "Escape" }), "escape", "mac")).toBe(true);
});

test("an IME composition (Korean input) or a key repeat never matches", () => {
  expect(matchesHotkey(key({ metaKey: true, isComposing: true }), "mod+k", "mac")).toBe(false);
  expect(matchesHotkey(key({ metaKey: true, key: "Process", keyCode: 229 }), "mod+k", "mac")).toBe(false);
  expect(matchesHotkey(key({ metaKey: true, keyCode: 229 }), "mod+k", "mac")).toBe(false);
  expect(matchesHotkey(key({ metaKey: true, repeat: true }), "mod+k", "mac")).toBe(false);
});

const GLOBAL_KEYS = ["window", "document", "navigator", "HTMLElement", "Node", "KeyboardEvent", "IS_REACT_ACT_ENVIRONMENT"];
const saved = GLOBAL_KEYS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

function Probe({ onHit, enabled }: { onHit: () => void; enabled: boolean }) {
  useHotkey("mod+k", onHit, { enabled });
  return null;
}

test("the hook handles the combo once, prevents the default only when it handles it, and respects enabled", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.defineProperty(dom.window.navigator, "platform", { value: "MacIntel", configurable: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
  root = createRoot(dom.window.document.getElementById("root")!);
  let hits = 0;
  await act(async () => root!.render(<Probe enabled onHit={() => { hits += 1; }} />));
  const press = (init: KeyboardEventInit & { keyCode?: number }) => {
    const event = new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    if (init.keyCode) Object.defineProperty(event, "keyCode", { value: init.keyCode });
    dom.window.document.body.dispatchEvent(event);
    return event;
  };
  expect(press({ key: "k", metaKey: true }).defaultPrevented).toBe(true);
  expect(hits).toBe(1);
  expect(press({ key: "k", metaKey: true, isComposing: true }).defaultPrevented).toBe(false);
  expect(press({ key: "j", metaKey: true }).defaultPrevented).toBe(false);
  expect(hits).toBe(1);
  // A key another handler already took (defaultPrevented) is left alone.
  const taken = (event: Event) => event.preventDefault();
  dom.window.document.body.addEventListener("keydown", taken);
  press({ key: "k", metaKey: true });
  dom.window.document.body.removeEventListener("keydown", taken);
  expect(hits).toBe(1);
  await act(async () => root!.render(<Probe enabled={false} onHit={() => { hits += 1; }} />));
  expect(press({ key: "k", metaKey: true }).defaultPrevented).toBe(false);
  expect(hits).toBe(1);
});

function Pair({ log }: { log: string[] }) {
  useHotkey("mod+k", () => log.push("default"));
  useHotkey("mod+k", () => log.push("high"), { priority: "high" });
  return null;
}

test("a high-priority owner takes the key before default owners, whatever the mount order", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.defineProperty(dom.window.navigator, "platform", { value: "MacIntel", configurable: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, KeyboardEvent: dom.window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
  root = createRoot(dom.window.document.getElementById("root")!);
  const log: string[] = [];
  await act(async () => root!.render(<Pair log={log} />));
  dom.window.document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
  expect(log).toEqual(["high"]);
});
