/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderLogo } from "../ProviderLogo";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./Select";

const css = readFileSync(new URL("./Select.module.css", import.meta.url), "utf8");

afterEach(() => {
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "DocumentFragment", "MutationObserver", "Element", "Event", "CustomEvent", "getComputedStyle"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

test("SelectValue puts a decorative icon before the chosen value in the trigger", () => {
  const markup = renderToStaticMarkup(
    <Select value="claude">
      <SelectTrigger aria-label="Service">
        <SelectValue icon={<ProviderLogo name="claude" />}>Claude</SelectValue>
      </SelectTrigger>
    </Select>,
  );
  const trigger = new JSDOM(markup).window.document.querySelector('[data-slot="select-trigger"]')!;
  const icon = trigger.querySelector('[data-slot="select-value-icon"]');
  expect(icon?.getAttribute("aria-hidden")).toBe("true");
  expect(icon?.querySelector('[data-slot="provider-logo"]')).not.toBeNull();
  // The vendored SVG carries a <title>; the value text itself is the label.
  expect(icon?.parentElement?.lastChild?.textContent).toBe("Claude");
});

test("SelectItem shows its icon outside the item text, so the typeahead and value text stay plain", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { pretendToBeVisual: true });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, DocumentFragment: dom.window.DocumentFragment,
    MutationObserver: dom.window.MutationObserver, Element: dom.window.Element,
    Event: dom.window.Event, CustomEvent: dom.window.CustomEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  });
  // Radix focuses and scrolls the selected item into view on open.
  dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(
    <Select open value="openai">
      <SelectTrigger aria-label="Service"><SelectValue /></SelectTrigger>
      <SelectContent position="popper">
        <SelectGroup>
          <SelectItem value="openai" icon={<ProviderLogo name="openai" />}>OpenAI</SelectItem>
          <SelectItem value="plain">Plain</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>,
  ));
  const items = Array.from(dom.window.document.querySelectorAll('[data-slot="select-item"]'));
  expect(items).toHaveLength(2);
  const icon = items[0]!.querySelector('[data-slot="select-item-icon"]');
  expect(icon?.getAttribute("aria-hidden")).toBe("true");
  expect(icon?.querySelector('[data-slot="provider-logo"]')).not.toBeNull();
  expect(items[0]!.getAttribute("data-has-icon")).toBe("true");
  expect(items[1]!.querySelector('[data-slot="select-item-icon"]')).toBeNull();
  expect(items[1]!.getAttribute("data-has-icon")).toBeNull();
  await act(async () => root.unmount());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
});

test("icons sit in a fixed, non-shrinking slot on the icon size scale", () => {
  expect(css).toMatch(/\.itemIcon,\s*\.valueIcon\s*\{[^}]*flex: none;[^}]*width: var\(--icon-size-md\)/u);
  expect(css).toMatch(/\.valueWithIcon\s*\{[^}]*display: inline-flex;[^}]*gap: var\(--space-sm\)/u);
});
