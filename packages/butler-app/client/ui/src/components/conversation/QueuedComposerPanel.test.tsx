/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { QueuedMessageRecord } from "@/app/types.ts";

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("failed sends are not presented as waiting messages", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { QueuedComposerPanel } = await import("./QueuedComposerPanel.tsx");
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) throw new Error("Missing root.");
  root = createRoot(container);

  await act(async () => root?.render(
    <QueuedComposerPanel
      messages={[
        queueMessage("queued-message", "queued"),
        queueMessage("failed-message", "failed"),
      ]}
      onEdit={() => undefined}
      onDelete={() => undefined}
    />,
  ));

  expect(container.textContent).toContain("Queued messages");
  expect(container.textContent).toContain("Failed messages");
  expect(container.textContent).toContain("Queued");
  expect(container.textContent).toContain("Send failed");
});

function queueMessage(
  id: string,
  state: QueuedMessageRecord["state"],
): QueuedMessageRecord {
  return {
    id,
    chat_id: "chat-queue-status",
    text: id,
    controls: {
      model: "openai/gpt-5.5",
      reasoning_effort: "low",
      access_mode: "full_access",
      plan_mode: false,
    },
    state,
    cursor: 1,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  };
}
