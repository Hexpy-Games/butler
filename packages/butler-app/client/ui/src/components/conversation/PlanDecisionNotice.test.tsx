/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { Root } from "react-dom/client";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { PlanDecisionAction } from "@/app/types.ts";
import { useComposerStore } from "./composerStore";
import {
  latestPendingPlan,
  PlanDecisionNotice,
  submitProjectedPlanDecision,
} from "./PlanDecisionNotice";

const initialButlerState = useButlerStore.getState();
const initialComposerState = useComposerStore.getState();
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  useButlerStore.setState(initialButlerState);
  useComposerStore.setState(initialComposerState);
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { Element?: unknown }).Element;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { HTMLButtonElement?: unknown }).HTMLButtonElement;
  delete (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement;
  delete (globalThis as { SVGElement?: unknown }).SVGElement;
  delete (globalThis as { DocumentFragment?: unknown }).DocumentFragment;
  delete (globalThis as { InputEvent?: unknown }).InputEvent;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { CustomEvent?: unknown }).CustomEvent;
  delete (globalThis as { MouseEvent?: unknown }).MouseEvent;
  delete (globalThis as { KeyboardEvent?: unknown }).KeyboardEvent;
  delete (globalThis as { FocusEvent?: unknown }).FocusEvent;
  delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
  delete (globalThis as { requestAnimationFrame?: unknown })
    .requestAnimationFrame;
  delete (globalThis as { cancelAnimationFrame?: unknown })
    .cancelAnimationFrame;
  delete (globalThis as { Event?: unknown }).Event;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("submits a decision against the latest pending Plan and applies returned controls", async () => {
  const dom = installDom();
  const calls: Array<{ action: PlanDecisionAction; instruction?: string }> = [];
  const projectedModes: boolean[] = [];
  useButlerStore.setState({
    activeChatId: "session-plan",
    messages: [
      {
        id: "message-plan",
        role: "assistant",
        text: "Here is the Plan.",
        plan_document: {
          id: "plan-1",
          title: "Composer Plan",
          status: "draft",
          markdown: "# Plan",
        },
      },
    ],
    submitPlanDecision: async (_sessionId, _planId, action, instruction) => {
      calls.push({ action, instruction });
      return {
        plan_document: {
          id: "plan-1",
          kind: "plan",
          title: "Composer Plan",
          status: action === "accept" ? "active" : "draft",
          markdown: "# Plan",
          safe_path_label: "Plan",
          updated_at: "2026-09-04T00:00:00.000Z",
        },
        controls: {
          session_id: "session-plan",
          controls: {
            model: "openai/gpt-5.5",
            reasoning_effort: "medium",
            access_mode: "full_access",
            plan_mode: action !== "accept",
          },
          revision: 2,
          catalog_generation: "test",
        },
      };
    },
  });
  useComposerStore.getState().setSnapshot({
    applyServerPlanMode: (enabled) => projectedModes.push(enabled),
  });

  const container = dom.window.document.querySelector("#root")!;
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
  await act(async () => root?.render(<PlanDecisionNotice />));
  expect(container.querySelector("input")?.getAttribute("aria-label")).toBe(
    appCopy.composer.planInstruction,
  );
  const accept = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === appCopy.composer.planAccept,
  );
  if (!(accept instanceof dom.window.HTMLButtonElement)) {
    throw new Error("Missing accept action.");
  }
  await act(async () => accept.click());

  expect(calls).toEqual([{ action: "accept", instruction: undefined }]);
  expect(projectedModes).toEqual([false]);
});

test("direct instructions use the instruct action and returned Plan mode", async () => {
  const calls: unknown[] = [];
  const projectedModes: boolean[] = [];
  const applied = await submitProjectedPlanDecision({
    action: "instruct",
    activeChatId: "session-plan",
    applyPlanMode: (enabled) => projectedModes.push(enabled),
    instruction: "  Keep the drawer flat  ",
    planId: "plan-1",
    submit: async (sessionId, planId, action, instruction) => {
      calls.push({ sessionId, planId, action, instruction });
      return {
        plan_document: {
          id: "plan-1",
          kind: "plan",
          title: "Composer Plan",
          status: "draft",
          markdown: "# Revised Plan",
          safe_path_label: "Plan",
          updated_at: "2026-09-04T00:00:00.000Z",
        },
        controls: {
          session_id: "session-plan",
          controls: {
            model: "openai/gpt-5.5",
            reasoning_effort: "medium",
            access_mode: "full_access",
            plan_mode: true,
          },
          revision: 3,
          catalog_generation: "test",
        },
      };
    },
  });

  expect(applied).toBe(true);
  expect(calls).toEqual([
    {
      sessionId: "session-plan",
      planId: "plan-1",
      action: "instruct",
      instruction: "Keep the drawer flat",
    },
  ]);
  expect(projectedModes).toEqual([true]);
});

test("an active newest Plan suppresses an older draft decision form", () => {
  expect(
    latestPendingPlan([
      {
        id: "draft-message",
        role: "assistant",
        text: "Draft",
        plan_document: {
          id: "plan-1",
          title: "Plan",
          status: "draft",
          markdown: "# Draft",
        },
      },
      {
        id: "active-message",
        role: "assistant",
        text: "Accepted",
        plan_document: {
          id: "plan-1",
          title: "Plan",
          status: "active",
          markdown: "# Active",
        },
      },
    ]),
  ).toBeNull();
});

function installDom() {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const ResizeObserverStub = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    SVGElement: dom.window.SVGElement,
    DocumentFragment: dom.window.DocumentFragment,
    InputEvent: dom.window.InputEvent,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    FocusEvent: dom.window.FocusEvent,
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: ResizeObserverStub,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return dom;
}
