/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { MessageRecord } from "@/app/types.ts";
import { MessageContent } from "./MessageContent";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("completed unbound ordinary turn discloses 작업 중 and operation rows", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) throw new Error("Missing root.");
  const root = createRoot(container);
  const message: MessageRecord = {
    id: "assistant-message",
    role: "assistant",
    text: "완료했습니다.",
    status: "delivered",
    turn_id: "turn-unbound",
    turn_activity_rows: [
      {
        id: "operation-1",
        kind: "ran_command",
        state: "completed",
        safe_label: "Bun 실행 완료",
        safe_tool_name: "Bun",
        safe_input_label: "bun test activity",
        tool_call_id: "tool-ordinary-1",
        bridge_phase: "btcc_operation",
        semantic_block_id: "turn-unbound",
      },
    ],
  };

  await act(async () => {
    root.render(
      <MessageContent
        message={message}
        copied={false}
        footerMeta={null}
        onCopyAssistantMessage={() => undefined}
      />,
    );
  });

  const header = container.querySelector(
    '[data-test-class="toggle-turn-activity-disclosure"]',
  );
  if (!(header instanceof dom.window.HTMLButtonElement)) {
    throw new Error("Missing completed activity disclosure header.");
  }
  expect(header.textContent).toContain("활동 · 작업 중");
  expect(container.textContent).not.toContain("Bun 실행 완료");

  await act(async () => header.click());
  expect(container.textContent).toContain("Bun 실행 완료");
  expect(container.querySelector("[data-work-stage]")).toBeNull();
  await act(async () => root.unmount());
});
