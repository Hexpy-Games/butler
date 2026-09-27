/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Collapsible } from "./Collapsible";

const css = readFileSync(new URL("./Collapsible.module.css", import.meta.url), "utf8");
const GLOBAL_KEYS = ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"];
const saved = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
let root: Root | null = null;

function setup(transitionDuration: string) {
  const dom = new JSDOM('<div id="root"></div>');
  Object.assign(dom.window, {
    getComputedStyle: () => ({ animationName: "none", transitionDuration, transitionDelay: "0s" }),
  });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
  });
  root = createRoot(dom.window.document.getElementById("root")!);
  return dom.window.document;
}

async function render(open: boolean) {
  await act(async () => root!.render(
    <Collapsible open={open} id="details" data-test-class="details">
      <span>Tool output</span>
    </Collapsible>,
  ));
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test("Collapsible renders nothing while closed and never opened", async () => {
  const document = setup("0.16s");
  await render(false);
  expect(document.querySelector('[data-test-class="details"]')).toBeNull();
});

test("Collapsible opens with an enter reveal only after a toggle", async () => {
  const document = setup("0.16s");
  await render(true);
  const initial = document.querySelector('[data-test-class="details"]');
  expect(initial?.getAttribute("data-state")).toBe("open");
  expect(initial?.hasAttribute("data-enter")).toBe(false);
  expect(initial?.id).toBe("details");
  await render(false);
  await act(async () => {
    document.querySelector('[data-test-class="details"]')!
      .dispatchEvent(new document.defaultView!.Event("transitionend", { bubbles: true }));
  });
  expect(document.querySelector('[data-test-class="details"]')).toBeNull();
  await render(true);
  expect(document.querySelector('[data-test-class="details"]')?.getAttribute("data-enter")).toBe("true");
});

test("Collapsible keeps closing content mounted until the height transition ends", async () => {
  const document = setup("0.11s");
  await render(true);
  await render(false);
  expect(document.querySelector('[data-test-class="details"]')?.getAttribute("data-state")).toBe("closed");
});

test("Collapsible reveals height with interpolate-size and fades only under reduced motion", () => {
  expect(css).toContain("interpolate-size: allow-keywords");
  expect(css).toMatch(/overflow: clip/u);
  expect(css).toMatch(/transition:\s*height var\(--motion-base\) var\(--motion-ease-standard\),\s*opacity var\(--motion-base\)/u);
  expect(css).toMatch(/@starting-style \{\s*\.collapsible\[data-enter="true"\]\[data-state="open"\] \{\s*height: 0;\s*opacity: 0;/u);
  expect(css).toMatch(/\.collapsible\[data-state="closed"\] \{[^}]*height: 0;[^}]*opacity: 0;[^}]*var\(--motion-exit-base\)/u);
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  // Reduced motion never animates height: it snaps, but only after the
  // content has faded out, so closing still gives visible feedback.
  expect(reduced).toMatch(/\.collapsible \{\s*transition:\s*height 0s,\s*opacity var\(--motion-fast\)/u);
  expect(reduced).toMatch(/\.collapsible\[data-state="closed"\] \{\s*transition:\s*opacity var\(--motion-exit-base\) var\(--motion-ease-accelerate\),\s*height 0s var\(--motion-exit-base\);/u);
});

test("keepMounted keeps closed content in the DOM (hidden) so editors keep their state", async () => {
  const document = setup("0.11s");
  await act(async () => root!.render(
    <Collapsible open={false} keepMounted data-test-class="kept"><span>Draft</span></Collapsible>,
  ));
  const kept = document.querySelector('[data-test-class="kept"]');
  expect(kept?.getAttribute("data-state")).toBe("closed");
  expect(kept?.textContent).toBe("Draft");
  expect(kept?.hasAttribute("inert")).toBe(true);
  await act(async () => root!.render(
    <Collapsible open keepMounted data-test-class="kept"><span>Draft</span></Collapsible>,
  ));
  expect(kept?.getAttribute("data-state")).toBe("open");
  expect(kept?.getAttribute("data-enter")).toBe("true");
  expect(kept?.hasAttribute("inert")).toBe(false);
  expect(css).toMatch(/\.collapsible\[data-state="closed"\]\[data-keep-mounted="hidden"\] \{[^}]*visibility: hidden/u);
});

test("appear reveals content that mounts open (a list row inserted later)", async () => {
  const document = setup("0.16s");
  await act(async () => root!.render(<Collapsible open appear data-test-class="row"><span>New</span></Collapsible>));
  expect(document.querySelector('[data-test-class="row"]')?.getAttribute("data-enter")).toBe("true");
});

test("onExitComplete fires once the closed content unmounts", async () => {
  const document = setup("0.11s");
  let exited = 0;
  const node = (open: boolean) => (
    <Collapsible open={open} onExitComplete={() => { exited += 1; }} data-test-class="row"><span>Row</span></Collapsible>
  );
  await act(async () => root!.render(node(true)));
  await act(async () => root!.render(node(false)));
  expect(exited).toBe(0);
  await act(async () => {
    document.querySelector('[data-test-class="row"]')!
      .dispatchEvent(new document.defaultView!.Event("transitionend", { bubbles: true }));
  });
  expect(document.querySelector('[data-test-class="row"]')).toBeNull();
  expect(exited).toBe(1);
});

test("keepMounted focusable collapses without inert so its owner can reopen it on focus", async () => {
  const document = setup("0.11s");
  await act(async () => root!.render(
    <Collapsible open={false} keepMounted="focusable" data-test-class="editor"><span>Editor</span></Collapsible>,
  ));
  const editor = document.querySelector('[data-test-class="editor"]');
  expect(editor?.getAttribute("data-keep-mounted")).toBe("focusable");
  expect(editor?.hasAttribute("inert")).toBe(false);
  expect(css).toMatch(/\.collapsible\[data-state="closed"\]\[data-keep-mounted="focusable"\] \{\s*pointer-events: none;/u);
});
