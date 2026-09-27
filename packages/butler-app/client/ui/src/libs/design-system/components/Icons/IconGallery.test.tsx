/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { Root } from "react-dom/client";
import * as Icons from "./Icons";
import { IconGallery, iconCatalog } from "./IconGallery";

const GLOBAL_KEYS = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Event", "Node", "IS_REACT_ACT_ENVIRONMENT"];
const saved = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
let root: Root | null = null;
let copied: string[] = [];

async function setup() {
  const dom = new JSDOM('<div id="root"></div>');
  copied = [];
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: { writeText: async (text: string) => { copied.push(text); } },
    configurable: true,
  });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Event: dom.window.Event,
    Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
  });
  // Load React DOM after the DOM globals exist so it enables input events.
  const { createRoot } = await import("react-dom/client");
  root = createRoot(dom.window.document.getElementById("root")!);
  return dom;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test("the catalog lists every exported glyph once, with its aliases", () => {
  const glyphs = new Set(Object.entries(Icons)
    .filter(([name, value]) => typeof value === "function" && /^[A-Z]/u.test(name) && name !== "Icon")
    .map(([, value]) => value));
  expect(iconCatalog.length).toBe(glyphs.size);
  expect(iconCatalog.length).toBeGreaterThan(60);
  const chevron = iconCatalog.find((entry) => entry.name === "ChevronDown");
  expect(chevron?.aliases).toContain("ChevronDownIcon");
});

test("the gallery filters by name or alias and copies the name on click", async () => {
  const dom = await setup();
  await act(async () => root!.render(<IconGallery />));
  const document = dom.window.document;
  const tiles = () => [...document.querySelectorAll<HTMLButtonElement>("[data-icon-name]")];
  expect(tiles().length).toBe(iconCatalog.length);

  const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(search, "chevrondownicon");
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    search.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  expect(tiles().map((tile) => tile.dataset.iconName)).toEqual(["ChevronDown"]);

  await act(async () => { tiles()[0]!.click(); });
  expect(copied).toEqual(["ChevronDown"]);
  expect(tiles()[0]!.getAttribute("data-copied")).toBe("true");
});

test("sizes come from the icon token scale", async () => {
  const dom = await setup();
  await act(async () => root!.render(<IconGallery />));
  const sizes = [...dom.window.document.querySelectorAll<HTMLButtonElement>("[data-icon-size]")].map((b) => b.dataset.iconSize);
  expect(sizes).toEqual(Object.keys(Icons.ICON_SIZE));
});
