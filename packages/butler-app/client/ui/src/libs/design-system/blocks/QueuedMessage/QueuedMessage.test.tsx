/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueuedMessage } from "./QueuedMessage";

const css = readFileSync(new URL("./QueuedMessage.module.css", import.meta.url), "utf8");
const GLOBAL_KEYS = ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"] as const;
const saved = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

const labels = {
  editLabel: "Edit queued message",
  deleteLabel: "Delete queued message",
  sendNowLabel: "Send now",
  sendNowHint: "Stop the current response and send this next",
};

test("a queued message shows its status above a pending bubble and its actions below", () => {
  const html = renderToStaticMarkup(
    <QueuedMessage status="Queued · 1 of 2" {...labels} onEdit={() => undefined} onDelete={() => undefined}
      onSendNow={() => undefined} ariaLabel="Queued message">
      Add screenshots to the report.
    </QueuedMessage>,
  );
  expect(html).toContain('data-test-class="queued-message"');
  expect(html).toContain('data-tone="queued"');
  expect(html).toContain('aria-label="Queued message"');
  const status = html.indexOf("Queued · 1 of 2");
  const bubble = html.indexOf("Add screenshots to the report.");
  const sendNow = html.indexOf(">Send now<");
  expect(status).toBeGreaterThan(-1);
  expect(status).toBeLessThan(bubble);
  expect(bubble).toBeLessThan(sendNow);
  expect(html).toContain('aria-label="Edit queued message"');
  expect(html).toContain('aria-label="Delete queued message"');
});

test("send now is optional and failed or sending rows keep their tone", () => {
  const html = renderToStaticMarkup(
    <QueuedMessage status="Send failed" tone="failed" {...labels} onEdit={() => undefined} onDelete={() => undefined}>
      Retry me
    </QueuedMessage>,
  );
  expect(html).not.toContain("Send now");
  expect(html).toContain('data-tone="failed"');
  const sending = renderToStaticMarkup(
    <QueuedMessage status="Sending…" tone="sending" {...labels} onEdit={() => undefined} onDelete={() => undefined}
      onSendNow={() => undefined}>
      Going out
    </QueuedMessage>,
  );
  expect(sending).toContain('data-tone="sending"');
  expect(sending.match(/disabled=""/gu)?.length).toBe(3);
});

test("the controls call their handlers", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const calls: string[] = [];
  root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root!.render(
    <QueuedMessage status="Queued" {...labels} onEdit={() => calls.push("edit")} onDelete={() => calls.push("delete")}
      onSendNow={() => calls.push("send-now")}>
      Text
    </QueuedMessage>,
  ));
  const buttons = [...dom.window.document.querySelectorAll("button")];
  for (const button of buttons) await act(async () => button.click());
  expect(calls).toEqual(["send-now", "edit", "delete"]);
});

test("the pending bubble reuses the user bubble tokens with a dashed hairline outline", () => {
  expect(css).toMatch(/\.bubble \{[^}]*outline: var\(--border-hairline\) dashed var\(--line-strong\);/u);
  expect(css).toMatch(/\.bubble \{[^}]*background-color: color-mix\(in srgb, var\(--user-message-bg\) 40%, transparent\);/u);
  expect(css).toMatch(/\.row\[data-enter="true"\] \{\s*animation: queued-enter var\(--motion-base\)\s+var\(--motion-ease-decelerate\)/u);
  expect(css).toMatch(/@keyframes queued-enter \{\s*from \{\s*opacity: 0;\s*translate: 0 var\(--motion-distance-sm\);/u);
});
