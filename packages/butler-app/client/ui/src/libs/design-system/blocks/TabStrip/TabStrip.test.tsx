/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { TabStrip, type TabStripProps } from "./TabStrip";
import { applyTabStripMove, type TabStripGroup, type TabStripMove } from "./tabStripModel";

const groups: TabStripGroup[] = [
  { id: "mine", kind: "mine", tabs: [{ id: "a1", title: "Docs" }, { id: "a2", title: "Mail", state: "loading" }] },
  { id: "c1", kind: "conversation", label: "Shopping", state: "waiting", tabs: [{ id: "b1", title: "Cart", state: "crashed" }] },
  { id: "c2", kind: "conversation", label: "Trip", collapsed: true, tabs: [{ id: "c1t", title: "Hotel" }] },
];

const noop = () => undefined;

// test-category: format-pin
test("groups render as labelled tablists with toggle chips and one roving tab stop", () => {
  const document = new JSDOM(renderToStaticMarkup(
    <TabStrip groups={groups} activeTabId="a2" panelId="page" onActivate={noop} onClose={noop} onToggleGroup={noop} onNewTab={noop} />,
  )).window.document;
  const lists = [...document.querySelectorAll('[role="tablist"]')].map((list) => list.getAttribute("aria-label"));
  expect(lists).toEqual(["My tabs", "Shopping"]);
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual(["Docs", "Mail, Loading", "Cart, Page stopped"]);
  expect(tabs.map((tab) => tab.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
  expect(tabs[1]!.getAttribute("aria-controls")).toBe("page");
  const chips = [...document.querySelectorAll('[data-test-class="tab-strip-chip"] [role="button"]')];
  expect(chips.map((chip) => [chip.getAttribute("aria-label"), chip.getAttribute("aria-expanded")])).toEqual([
    ["My tabs, 2 tabs", "true"], ["Shopping, 1 tab, Waiting for approval", "true"], ["Trip, 1 tab", "false"],
  ]);
  expect(document.querySelector('[aria-label="New tab"]')).not.toBeNull();
});

async function mount(props: Partial<TabStripProps>) {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"];
  const saved = Object.fromEntries(keys.map((key) => [key, (globalThis as Record<string, unknown>)[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(<TabStrip groups={groups} activeTabId="a1" onActivate={noop} onClose={noop} {...props} />));
  const press = async (label: string, key: string, init: KeyboardEventInit = {}) => {
    const target = dom.window.document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
    await act(async () => target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, ...init })));
  };
  const focused = () => dom.window.document.activeElement?.getAttribute("aria-label");
  const cleanup = async () => {
    await act(async () => root.unmount());
    Object.assign(globalThis, saved);
  };
  return { press, focused, cleanup };
}

// test-category: format-pin
test("arrows, Home and End move focus; Delete closes; Cmd+Shift+arrow moves across groups", async () => {
  const closed: string[] = [];
  const moves: TabStripMove[] = [];
  const view = await mount({ onClose: (id) => closed.push(id), onMove: (move) => moves.push(move), onToggleGroup: noop });
  try {
    await view.press("Docs", "ArrowRight");
    expect(view.focused()).toBe("Mail, Loading");
    await view.press("Mail, Loading", "End");
    expect(view.focused()).toBe("Trip, 1 tab");
    await view.press("Trip, 1 tab", "ArrowRight");
    expect(view.focused()).toBe("My tabs, 2 tabs");
    await view.press("Cart, Page stopped", "Delete");
    expect(closed).toEqual(["b1"]);
    await view.press("Mail, Loading", "ArrowRight", { metaKey: true, shiftKey: true });
    expect(moves).toEqual([{ tabId: "a2", fromGroupId: "mine", toGroupId: "c1", index: 0 }]);
  } finally {
    await view.cleanup();
  }
});

// test-category: pure-logic
test("applyTabStripMove moves a tab into its target group at the given index", () => {
  const next = applyTabStripMove(groups, { tabId: "a2", fromGroupId: "mine", toGroupId: "c1", index: 0 });
  expect(next.map((group) => group.tabs.map((tab) => tab.id))).toEqual([["a1"], ["a2", "b1"], ["c1t"]]);
  expect(next[2]).toBe(groups[2]!);
});
