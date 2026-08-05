/// <reference types="bun" />

import { act, useState } from "react";
import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  reorderSortableCardItems,
  SortableCardList,
  type SortableCardListItem,
} from "./SortableCardList";

const items: SortableCardListItem[] = [
  { id: "one", label: "One", title: "One", meta: "Provider A" },
  { id: "two", label: "Two", title: "Two", meta: "Provider B" },
];

function createPointerEvent(
  dom: JSDOM,
  type: "pointerdown" | "pointermove" | "pointerup",
  coordinates: { x: number; y: number },
) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { configurable: true, value: 0 },
    clientX: { configurable: true, value: coordinates.x },
    clientY: { configurable: true, value: coordinates.y },
    isPrimary: { configurable: true, value: true },
    pointerId: { configurable: true, value: 1 },
  });
  return event;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
  delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("renders accessible drag handles, ordered cards, and remove controls", () => {
  const html = renderToStaticMarkup(
    <SortableCardList items={items} onReorder={() => undefined} onRemove={() => undefined} />,
  );
  const document = new JSDOM(html).window.document;
  const handles = document.querySelectorAll("[data-sortable-handle]");
  expect(handles).toHaveLength(2);
  expect(handles[0]?.getAttribute("aria-roledescription")).toBe("sortable");
  expect(handles[0]?.getAttribute("aria-label")).toBe("Reorder One");
  expect(document.querySelector('[aria-label="Remove One"]')).not.toBeNull();
  expect(document.querySelector('[data-sortable-id="one"]')).not.toBeNull();
});

test("supports empty state and immutable keyboard reorder policy", () => {
  const html = renderToStaticMarkup(
    <SortableCardList items={[]} onReorder={() => undefined} emptyMessage="Add a backup model." />,
  );
  expect(html).toContain("Add a backup model.");
  const next = reorderSortableCardItems(items, "one", "two");
  expect(next.map((item) => item.id)).toEqual(["two", "one"]);
  expect(items.map((item) => item.id)).toEqual(["one", "two"]);
});

test("removal remains keyboard operable through the DS button", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  });
  const removed: string[] = [];
  const root = createRoot(dom.window.document.querySelector("#root")!);
  await act(async () => root.render(
    <SortableCardList items={items} onReorder={() => undefined} onRemove={(id) => removed.push(id)} />,
  ));
  const remove = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Remove One"]');
  expect(remove?.tabIndex).toBe(0);
  await act(async () => remove?.click());
  expect(removed).toEqual(["one"]);
  await act(async () => root.unmount());
});

test("keyboard sensor moves a card and commits the ordered callback", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value() {
      const id = this.getAttribute("data-sortable-id");
      const index = id === "two" ? 1 : 0;
      return {
        top: index * 100,
        bottom: index * 100 + 80,
        left: 0,
        right: 320,
        width: 320,
        height: 80,
        x: 0,
        y: index * 100,
        toJSON: () => ({}),
      };
    },
  });
  const root = createRoot(dom.window.document.querySelector("#root")!);
  function Harness() {
    const [ordered, setOrdered] = useState(items);
    return <SortableCardList items={ordered} onReorder={setOrdered} />;
  }
  await act(async () => root.render(<Harness />));
  const handle = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Reorder One"]');
  if (!handle) throw new Error("Missing keyboard drag handle");
  await act(async () => {
    handle.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      bubbles: true,
      code: "Space",
      key: " ",
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await act(async () => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      bubbles: true,
      code: "ArrowDown",
      key: "ArrowDown",
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await act(async () => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      bubbles: true,
      code: "Space",
      key: " ",
    }));
  });
  const ids = [...dom.window.document.querySelectorAll<HTMLElement>("[data-sortable-id]")]
    .map((node) => node.dataset.sortableId);
  expect(ids).toEqual(["two", "one"]);
  await act(async () => root.unmount());
});

test("pointer sensor exposes a drop indicator and commits the ordered callback", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value() {
      const id = this.getAttribute("data-sortable-id");
      const index = id === "two" ? 1 : 0;
      return {
        top: index * 100,
        bottom: index * 100 + 80,
        left: 0,
        right: 320,
        width: 320,
        height: 80,
        x: 0,
        y: index * 100,
        toJSON: () => ({}),
      };
    },
  });
  const reordered: string[][] = [];
  const root = createRoot(dom.window.document.querySelector("#root")!);
  function Harness() {
    const [ordered, setOrdered] = useState(items);
    return (
      <SortableCardList
        items={ordered}
        onReorder={(nextItems) => {
          reordered.push(nextItems.map((item) => item.id));
          setOrdered(nextItems);
        }}
      />
    );
  }

  await act(async () => root.render(<Harness />));
  const handle = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Reorder One"]');
  if (!handle) throw new Error("Missing pointer drag handle");

  await act(async () => {
    handle.dispatchEvent(createPointerEvent(dom, "pointerdown", { x: 40, y: 40 }));
    dom.window.document.dispatchEvent(createPointerEvent(dom, "pointermove", { x: 40, y: 140 }));
    dom.window.document.dispatchEvent(createPointerEvent(dom, "pointermove", { x: 40, y: 150 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  const indicator = dom.window.document.querySelector('[data-drop-indicator="true"]');
  expect(indicator).not.toBeNull();
  expect(indicator?.getAttribute("aria-hidden")).toBe("true");
  expect(indicator?.parentElement?.getAttribute("data-sortable-id")).toBe("two");

  await act(async () => {
    dom.window.document.dispatchEvent(createPointerEvent(dom, "pointerup", { x: 40, y: 150 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(reordered).toEqual([["two", "one"]]);
  expect(dom.window.document.querySelector('[data-drop-indicator="true"]')).toBeNull();
  await act(async () => root.unmount());
});

test("DS owns keyboard sensor and reduced-motion behavior", () => {
  const source = readFileSync(new URL("./SortableCardList.tsx", import.meta.url), "utf8");
  const itemSource = readFileSync(new URL("./SortableCardItem.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("./SortableCardList.module.css", import.meta.url), "utf8");
  expect(source).toContain("KeyboardSensor");
  expect(source).toContain("sortableKeyboardCoordinates");
  expect(itemSource).toContain("data-drop-indicator");
  expect(itemSource).toContain("Separator");
  expect(styles).toContain("prefers-reduced-motion: reduce");
});
