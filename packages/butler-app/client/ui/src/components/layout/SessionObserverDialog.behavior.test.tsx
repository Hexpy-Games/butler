/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useButlerStore } from "@/app/store.ts";
import type { SessionView } from "@/app/types.ts";

let root: Root | undefined;
const initialObserverSessionId = useButlerStore.getState().observerSessionId;
const initialSessionViews = useButlerStore.getState().sessionViews;
const initialCancelObservedSteward = useButlerStore.getState().cancelObservedSteward;
const initialResumeObservedSteward = useButlerStore.getState().resumeObservedSteward;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  useButlerStore.setState({
    observerSessionId: initialObserverSessionId,
    sessionViews: initialSessionViews,
    cancelObservedSteward: initialCancelObservedSteward,
    resumeObservedSteward: initialResumeObservedSteward,
  });
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { Element?: unknown }).Element;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement;
  delete (globalThis as { HTMLButtonElement?: unknown }).HTMLButtonElement;
  delete (globalThis as { HTMLTextAreaElement?: unknown }).HTMLTextAreaElement;
  delete (globalThis as { HTMLSelectElement?: unknown }).HTMLSelectElement;
  delete (globalThis as { SVGElement?: unknown }).SVGElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { NodeFilter?: unknown }).NodeFilter;
  delete (globalThis as { DocumentFragment?: unknown }).DocumentFragment;
  delete (globalThis as { Event?: unknown }).Event;
  delete (globalThis as { CustomEvent?: unknown }).CustomEvent;
  delete (globalThis as { MouseEvent?: unknown }).MouseEvent;
  delete (globalThis as { KeyboardEvent?: unknown }).KeyboardEvent;
  delete (globalThis as { FocusEvent?: unknown }).FocusEvent;
  delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
  delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
  delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
});

test("observer dialog is named, focus-contained, read-only, and closes on Escape", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", {
    url: "http://localhost",
  });
  const window = dom.window;
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window,
    document: window.document,
    navigator: window.navigator,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLSelectElement: window.HTMLSelectElement,
    SVGElement: window.SVGElement,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    DocumentFragment: window.DocumentFragment,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    FocusEvent: window.FocusEvent,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  });
  Object.assign(window.HTMLElement.prototype, {
    attachEvent: () => undefined,
    detachEvent: () => undefined,
  });
  const container = window.document.querySelector("#root");
  if (!(container instanceof window.HTMLElement)) throw new Error("Missing root.");
  const sessionId = "steward-observer-behavior";
  const cancelledRelations: string[] = [];
  const resumedRelations: string[] = [];
  useButlerStore.setState({
    observerSessionId: sessionId,
    sessionViews: { [sessionId]: observerView(sessionId) },
    cancelObservedSteward: async (relationId) => {
      cancelledRelations.push(relationId);
      return true;
    },
    resumeObservedSteward: async (relationId) => {
      resumedRelations.push(relationId);
      return true;
    },
  });
  expect(useButlerStore.getState().observerSessionId).toBe(sessionId);
  root = createRoot(container);
  const { SessionObserverDialog } = await import("./SessionObserverDialog");
  await act(async () => root?.render(<SessionObserverDialog />));
  const dialog = window.document.querySelector('[role="dialog"]');
  if (!(dialog instanceof window.HTMLElement)) throw new Error("Missing observer dialog.");
  const labelledBy = dialog.getAttribute("aria-labelledby");
  expect(labelledBy).toBeTruthy();
  expect(window.document.getElementById(labelledBy ?? "")?.textContent)
    .toBe("Read-only Steward observer");
  expect(dialog.getAttribute("aria-describedby")).toBe("steward-observer-description");
  expect(dialog.contains(window.document.activeElement)).toBe(true);
  expect(Array.from(dialog.querySelectorAll("button")).map((button) => button.textContent))
    .not.toContain(expect.stringMatching(/copy/iu));
  expect(dialog.querySelector('[data-test-class*="composer"]')).toBeNull();
  expect(dialog.textContent).not.toContain("Composer");
  const timelineText = dialog.textContent ?? "";
  expect(timelineText.indexOf("Butler request")).toBeLessThan(
    timelineText.indexOf("Safe activity transcript"),
  );
  expect(timelineText.indexOf("Safe activity transcript")).toBeLessThan(
    timelineText.indexOf("Butler direction"),
  );
  const stopButton = Array.from(dialog.querySelectorAll("button")).find((button) =>
    /중지|stop/iu.test(button.textContent ?? ""),
  );
  expect(stopButton).toBeDefined();
  await act(async () => stopButton?.click());
  expect(cancelledRelations).toEqual(["observer-relation"]);

  await act(async () => {
    useButlerStore.setState({
      sessionViews: { [sessionId]: recoverableObserverView(sessionId) },
    });
  });
  const resumeButton = Array.from(dialog.querySelectorAll("button")).find((button) =>
    /이어서 진행|resume/iu.test(button.textContent ?? ""),
  );
  expect(resumeButton).toBeDefined();
  expect(Array.from(dialog.querySelectorAll("button")).some((button) =>
    /중지|stop/iu.test(button.textContent ?? ""),
  )).toBe(false);
  await act(async () => resumeButton?.click());
  expect(resumedRelations).toEqual(["observer-relation"]);

  await act(async () => {
    dialog.dispatchEvent(new window.KeyboardEvent("keydown", {
      bubbles: true,
      key: "Escape",
    }));
  });
  expect(useButlerStore.getState().observerSessionId).toBeNull();
  expect(window.document.querySelector('[role="dialog"]')).toBeNull();
});

function observerView(sessionId: string): SessionView {
  return {
    session_id: sessionId,
    kind: "chat",
    status: "active",
    active_turn: {
      id: "observer-active-turn",
      state: "thinking",
      cancellable: true,
      retryable: false,
      created_at: "2026-08-19T00:00:30.000Z",
      updated_at: "2026-08-19T00:00:30.000Z",
      progress: { safe_progress_rows: [] },
    },
    latest_turn: null,
    messages: [{
      id: "observer-request-message",
      role: "user",
      text: "Butler request",
      status: "delivered",
    }, {
      id: "observer-assistant-message",
      role: "assistant",
      text: "Safe activity transcript",
      status: "delivered",
    }, {
      id: "observer-direction-message",
      role: "user",
      text: "Butler direction",
      status: "delivered",
    }] as SessionView["messages"],
    message_window: { next_cursor: 3, complete: true },
    workers: [],
    work_streams: [],
    artifacts: [],
    context: null,
    branch: null,
    automations: [],
    errors: [],
    cursors: { messages: 3, events: 0 },
    relation: {
      relation_id: "observer-relation",
      parent_session_id: "parent-observer",
      parent_turn_id: "parent-turn",
      child_session_id: sessionId,
      anchor_message_id: "anchor-observer",
      ordinal: 1,
      safe_title: "Read-only Steward observer",
      created_at: "2026-08-19T00:00:00.000Z",
    },
    generated_at: "2026-08-19T00:01:00.000Z",
    updated_at: "2026-08-19T00:01:00.000Z",
  };
}

function recoverableObserverView(sessionId: string): SessionView {
  const view = observerView(sessionId);
  return {
    ...view,
    status: "failed",
    active_turn: null,
    latest_turn: {
      ...view.active_turn!,
      state: "runtime_fault",
      cancellable: false,
      retryable: true,
    },
  };
}
