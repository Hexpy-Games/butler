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
        turnId="turn-current"
        activities={[
          {
            id: "conception",
            phase: "conception_deliberation",
            title: "이전 목표 확인",
            summary: "이전 목표를 확인했습니다.",
            rationale: "의도를 보존하기 위해서입니다.",
            nextStep: "계획을 만듭니다.",
            operations: [],
          },
          {
            id: "planning",
            phase: "planning",
            title: "구현 순서 확정",
            summary: "구현 순서를 정했습니다.",
            rationale: "작업 경계를 분명히 하기 위해서입니다.",
            nextStep: "첫 작업을 실행합니다.",
            operations: [],
          },
        ]}
      />,
    );
  });

  expect(container.querySelector(
    '[data-test-class~="turn-current-phase-activity"]',
  )?.getAttribute("data-turn-id")).toBe("turn-current");
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
  const blocks = container.querySelectorAll('[data-test-class~="turn-work-block"]');
  expect(blocks[0]?.getAttribute("data-work-stage")).toBe("conception_deliberation");
  expect(blocks[1]?.getAttribute("data-work-stage")).toBe("planning");
  expect(blocks[0]?.getAttribute("data-connected")).toBe("true");
  expect(blocks[1]?.hasAttribute("data-connected")).toBe(false);
  await act(async () => root.unmount());
});

test("live activity rolls the prior block above the latest block", async () => {
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
  const container = dom.window.document.querySelector("#root")!;
  const root = createRoot(container);
  const first = activity("conception", "구상 내용을 확인했습니다.");

  await act(async () => root.render(
    <TurnActivityTimeline activities={[first]} live />,
  ));
  await act(async () => root.render(
    <TurnActivityTimeline
      activities={[first, activity("planning", "계획을 확정했습니다.")]}
      live
    />,
  ));

  expect(container.querySelector('[data-motion="outgoing"]')?.textContent)
    .toContain("구상 내용을 확인했습니다.");
  const incoming = container.querySelector('[data-motion="incoming"]');
  expect(incoming?.textContent).toContain("계획을 확정했습니다.");
  await act(async () => incoming?.dispatchEvent(
    new dom.window.Event("animationend", { bubbles: true }),
  ));
  expect(container.textContent).not.toContain("구상 내용을 확인했습니다.");
  await act(async () => root.unmount());
});

test("review and completion validation render as distinct user-visible phases", async () => {
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
  const container = dom.window.document.querySelector("#root")!;
  const root = createRoot(container);

  await act(async () => root.render(
    <TurnActivityTimeline
      activities={[
        activity("review", "실행 결과를 검토했습니다."),
        activity("validation", "전체 완료 조건을 검토했습니다."),
      ]}
      currentState="validation"
      live
    />,
  ));

  expect(container.textContent).toContain("현재 · 완료 검토 · 2개 기록");
  expect(container.textContent).toContain("완료 검토");
  const toggle = container.querySelector(
    '[data-test-class="toggle-turn-activity-history"]',
  );
  if (!(toggle instanceof dom.window.HTMLButtonElement)) {
    throw new Error("Missing activity history toggle.");
  }
  await act(async () => toggle.click());
  expect(container.textContent).toContain("작업 리뷰");
  expect(container.textContent).toContain("완료 검토");
  expect(container.querySelector('[data-work-stage="review"]')).not.toBeNull();
  expect(container.querySelector('[data-work-stage="validation"]')).not.toBeNull();
  await act(async () => root.unmount());
});

function activity(id: string, summary: string) {
  return {
    id,
    phase: id,
    title: summary,
    summary,
    rationale: "목표를 지키기 위해서입니다.",
    nextStep: "다음 단계를 진행합니다.",
    operations: [],
  };
}
