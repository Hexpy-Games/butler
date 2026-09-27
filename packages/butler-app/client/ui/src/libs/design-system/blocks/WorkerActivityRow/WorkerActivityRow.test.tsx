/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { WorkerActivityRow } from "./WorkerActivityRow";

const css = readFileSync(new URL("./WorkerActivityRow.module.css", import.meta.url), "utf8");
const KEYS = ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;

async function withDom(run: (render: (phase: string) => Promise<HTMLElement>) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>');
  const saved = KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await run(async (phase) => {
      await act(async () => root.render(<WorkerActivityRow id="w1" title="Worker" icon={<span>i</span>} phase={phase} />));
      return dom.window.document.getElementById("w1")!;
    });
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

test("WorkerActivityRow pulses once when its phase becomes complete while mounted", async () => {
  await withDom(async (render) => {
    let row = await render("executing");
    expect(row.hasAttribute("data-completed-now")).toBe(false);
    row = await render("complete");
    expect(row.getAttribute("data-completed-now")).toBe("true");
    await act(async () => row.dispatchEvent(new window.Event("animationend", { bubbles: true })));
    expect(row.hasAttribute("data-completed-now")).toBe(false);
  });
});

test("WorkerActivityRow does not animate rows that mount already complete", async () => {
  await withDom(async (render) => {
    const row = await render("complete");
    expect(row.hasAttribute("data-completed-now")).toBe(false);
  });
});

test("the success pulse uses motion tokens and has a reduced-motion rule", () => {
  expect(css).toMatch(/\[data-completed-now="true"\] \.icon\s*\{[^}]*animation:\s*worker-complete var\(--motion-deliberate\)\s+var\(--motion-ease-decelerate\)/u);
  expect(css).toMatch(/@keyframes worker-complete\s*\{[^@]*scale\(var\(--motion-scale-menu\)\)/u);
  expect(css).toMatch(/prefers-reduced-motion: reduce/u);
});
