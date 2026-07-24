/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { TurnActivityTimeline } from "./TurnActivityTimeline";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("turn activity keeps one latest item until view all expands in place", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", {
    url: "http://localhost",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <TurnActivityTimeline
        live
        activities={[
          {
            id: "conception",
            phase: "conception_deliberation",
            summary: "이전 목표를 확인했습니다.",
            rationale: "의도를 보존하기 위해서입니다.",
            nextStep: "계획을 만듭니다.",
          },
          {
            id: "planning",
            phase: "planning",
            summary: "구현 순서를 정했습니다.",
            rationale: "작업 경계를 분명히 하기 위해서입니다.",
            nextStep: "첫 작업을 실행합니다.",
          },
        ]}
      />,
    );
  });

  expect(container.textContent).not.toContain("이전 목표를 확인했습니다.");
  expect(container.textContent).toContain("구현 순서를 정했습니다.");
  const toggle = container.querySelector(
    '[data-test-class="toggle-turn-activity-history"]',
  );
  if (!(toggle instanceof dom.window.HTMLButtonElement)) {
    throw new Error("Missing activity history toggle.");
  }
  await act(async () => toggle.click());

  expect(container.textContent).toContain("이전 목표를 확인했습니다.");
  expect(container.textContent).toContain("구현 순서를 정했습니다.");
  expect(toggle.textContent).toContain("접기");
  await act(async () => root.unmount());
});
