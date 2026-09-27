/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { COPY_FEEDBACK_MS, CopyButton } from "./CopyButton";

const css = readFileSync(new URL("./CopyButton.module.css", import.meta.url), "utf8");
const GLOBAL_KEYS = ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"];
const saved = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
let root: Root | null = null;

function setup(writeText: (text: string) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>');
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText }, configurable: true });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
  });
  root = createRoot(dom.window.document.getElementById("root")!);
  return dom.window.document;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test("CopyButton copies text, morphs to the check and announces the result", async () => {
  const copied: string[] = [];
  const document = setup(async (text) => { copied.push(text); });
  await act(async () => root!.render(<CopyButton text="hello" label="Copy message" copiedLabel="Copied" />));
  const button = document.querySelector("button")!;
  expect(button.getAttribute("aria-label")).toBe("Copy message");
  expect(button.getAttribute("data-copied")).toBe("false");
  const status = document.querySelector('[role="status"]')!;
  expect(status.getAttribute("aria-live")).toBe("polite");
  expect(status.textContent).toBe("");
  await act(async () => { button.click(); });
  expect(copied).toEqual(["hello"]);
  expect(button.getAttribute("data-copied")).toBe("true");
  expect(button.getAttribute("aria-label")).toBe("Copied");
  expect(status.textContent).toBe("Copied");
  expect(COPY_FEEDBACK_MS).toBe(1500);
});

test("CopyButton reports clipboard failures and stays in the copy state", async () => {
  const document = setup(async () => { throw new Error("denied"); });
  const errors: unknown[] = [];
  await act(async () => root!.render(
    <CopyButton text={() => "lazy"} label="Copy" copiedLabel="Copied" onError={(error) => errors.push(error)} />,
  ));
  const button = document.querySelector("button")!;
  await act(async () => { button.click(); });
  expect(errors).toHaveLength(1);
  expect(button.getAttribute("data-copied")).toBe("false");
});

test("CopyButton can be driven by a parent copy action", async () => {
  const document = setup(async () => {});
  let calls = 0;
  await act(async () => root!.render(
    <CopyButton copied label="Copy" copiedLabel="Copied" onCopy={() => { calls += 1; }} />,
  ));
  const button = document.querySelector("button")!;
  expect(button.getAttribute("data-copied")).toBe("true");
  await act(async () => { button.click(); });
  expect(calls).toBe(1);
});

test("CopyButton crossfades and scales the icons and keeps a fade under reduced motion", () => {
  expect(css).toMatch(/\.icon \{[^}]*grid-area: 1 \/ 1;[^}]*transition:\s*opacity var\(--motion-fast\) var\(--motion-ease-standard\),\s*transform var\(--motion-fast\) var\(--motion-ease-standard\)/u);
  expect(css).toMatch(/\.button\[data-copied="true"\] \.copyIcon \{[^}]*opacity: 0;[^}]*transform: scale\(var\(--motion-scale-menu\)\)/u);
  expect(css).toMatch(/\.button\[data-copied="false"\] \.checkIcon \{[^}]*opacity: 0;/u);
});

test("each copy mounts a fresh drawing SuccessCheck, so the check animates every time", async () => {
  const document = setup(async () => {});
  await act(async () => root!.render(<CopyButton text="hello" label="Copy" copiedLabel="Copied" />));
  const button = document.querySelector("button")!;
  expect(document.querySelector('[data-slot="success-check"]')!.getAttribute("data-animate")).toBe("false");
  await act(async () => { button.click(); });
  const first = document.querySelector('[data-slot="success-check"]')!;
  expect(first.getAttribute("data-animate")).toBe("true");
  expect(first.querySelector("circle")).toBeNull();
  await act(async () => { button.click(); });
  // Still copied: the same check stays; it re-draws only after the copy icon has returned.
  expect(document.querySelector('[data-slot="success-check"]')).toBe(first);
});

test("parent-driven copied remounts the check on every false -> true", async () => {
  const document = setup(async () => {});
  const render = (copied: boolean) => act(async () => root!.render(<CopyButton copied={copied} label="Copy" copiedLabel="Copied" onCopy={() => undefined} />));
  await render(false);
  await render(true);
  const first = document.querySelector('[data-slot="success-check"]')!;
  expect(first.getAttribute("data-animate")).toBe("true");
  await render(false);
  await render(true);
  expect(document.querySelector('[data-slot="success-check"]')).not.toBe(first);
});
