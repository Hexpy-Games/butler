/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { FilteredSelectPopover } from "./FilteredSelectPopover";

const ROW_HEIGHT = 32;

async function renderInDom(node: React.ReactNode) {
  const dom = new JSDOM('<div id="root"></div>');
  const saved = Object.fromEntries(["window", "document", "navigator", "HTMLElement", "Node", "ResizeObserver", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, (globalThis as unknown as Record<string, unknown>)[key]]));
  class Observer { observe() {} unobserve() {} disconnect() {} }
  // Lay rows out top to bottom inside a 200px-tall results scroller at y=100.
  dom.window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const scroller = this.closest("[data-slot='filtered-select-results']");
    if (this.dataset.slot === "filtered-select-results") {
      return { top: 100, height: 200, bottom: 300, left: 0, right: 300, width: 300, x: 0, y: 100, toJSON() {} };
    }
    const rows = scroller ? [...scroller.querySelectorAll("[data-slot='filtered-select-item']")] : [];
    const index = rows.indexOf(this);
    const top = 100 + index * ROW_HEIGHT - (scroller?.scrollTop ?? 0);
    return { top, height: ROW_HEIGHT, bottom: top + ROW_HEIGHT, left: 0, right: 300, width: 300, x: 0, y: top, toJSON() {} };
  };
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.slot === "filtered-select-results" ? 200 : ROW_HEIGHT;
    },
  });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, ResizeObserver: Observer, MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(node));
  return {
    document: dom.window.document,
    async cleanup() {
      await act(async () => root.unmount());
      Object.assign(globalThis, saved);
    },
  };
}

function popover(selectedIndex: number) {
  const items = Array.from({ length: 30 }, (_, index) => ({
    id: `zone-${index}`,
    label: `Zone ${index}`,
    selected: index === selectedIndex,
  }));
  return (
    <FilteredSelectPopover
      title="Timezone"
      searchLabel="Search"
      searchPlaceholder="Search"
      searchClearLabel="Clear"
      searchValue=""
      filters={[{ id: "all", label: "All" }]}
      activeFilterId="all"
      onSearchChange={() => undefined}
      onFilterChange={() => undefined}
      groups={[{ id: "zones", title: "All", items }]}
      emptyLabel="None"
    />
  );
}

test("opening the popover scrolls the selected row into view", async () => {
  const view = await renderInDom(popover(20));
  try {
    const scroller = view.document.querySelector<HTMLElement>("[data-slot='filtered-select-results']")!;
    const selected = view.document.querySelector<HTMLElement>("[data-selected='true'][data-slot='filtered-select-item']")!;
    expect(scroller.scrollTop).toBeGreaterThan(0);
    const rowTop = selected.getBoundingClientRect().top;
    expect(rowTop).toBeGreaterThanOrEqual(100);
    expect(rowTop + ROW_HEIGHT).toBeLessThanOrEqual(300);
  } finally {
    await view.cleanup();
  }
});

test("the selected row carries aria-current and a trailing check mark", async () => {
  const view = await renderInDom(popover(2));
  try {
    const rows = [...view.document.querySelectorAll<HTMLElement>("[data-slot='filtered-select-item']")];
    const selected = rows.filter((row) => row.getAttribute("aria-current") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]!.textContent).toContain("Zone 2");
    expect(selected[0]!.querySelector("[data-slot='filtered-select-check'] svg")).not.toBeNull();
    expect(view.document.querySelectorAll("[data-slot='filtered-select-check']")).toHaveLength(1);
    const scroller = view.document.querySelector<HTMLElement>("[data-slot='filtered-select-results']")!;
    expect(scroller.scrollTop).toBe(0);
  } finally {
    await view.cleanup();
  }
});
