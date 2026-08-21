/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useButlerStore } from "@/app/store.ts";
import { useComposerStore } from "@/components/conversation/composerStore.ts";

let root: Root | undefined;
let dom: JSDOM | undefined;
const initialButlerState = {
  leftOpen: useButlerStore.getState().leftOpen,
  rightOpen: useButlerStore.getState().rightOpen,
  view: useButlerStore.getState().view,
  activeChatId: useButlerStore.getState().activeChatId,
  navigation: useButlerStore.getState().navigation,
  messages: useButlerStore.getState().messages,
  sessionView: useButlerStore.getState().sessionView,
  sessionViews: useButlerStore.getState().sessionViews,
  observerSessionId: useButlerStore.getState().observerSessionId,
  summary: useButlerStore.getState().summary,
  turnProgress: useButlerStore.getState().turnProgress,
};
const initialComposerEngaged = useComposerStore.getState().engaged;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  await new Promise((resolve) => setTimeout(resolve, 0));
  root = undefined;
  useButlerStore.setState(initialButlerState);
  useComposerStore.setState({ engaged: initialComposerEngaged });
  if (dom) dom.window.close();
  dom = undefined;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { HTMLButtonElement?: unknown }).HTMLButtonElement;
  delete (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement;
  delete (globalThis as { HTMLTextAreaElement?: unknown }).HTMLTextAreaElement;
  delete (globalThis as { SVGElement?: unknown }).SVGElement;
  delete (globalThis as { Element?: unknown }).Element;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { NodeFilter?: unknown }).NodeFilter;
  delete (globalThis as { DocumentFragment?: unknown }).DocumentFragment;
  delete (globalThis as { Event?: unknown }).Event;
  delete (globalThis as { CustomEvent?: unknown }).CustomEvent;
  delete (globalThis as { MouseEvent?: unknown }).MouseEvent;
  delete (globalThis as { KeyboardEvent?: unknown }).KeyboardEvent;
  delete (globalThis as { FocusEvent?: unknown }).FocusEvent;
  delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
  delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
  delete (globalThis as { fetch?: unknown }).fetch;
});

test("default VisualHarness render does not install SS-03 state", async () => {
  const rendered = await renderHarness("http://localhost/?visual=components");
  const state = useButlerStore.getState();

  expect(state.observerSessionId).toBeNull();
  expect(state.sessionViews).toEqual({});
  expect(state.leftOpen).toBe(false);
  expect(useComposerStore.getState().engaged).toBe(false);
  expect(rendered.document.querySelector('[role="dialog"]')).toBeNull();
  expect(rendered.container.textContent).not.toContain("Review the activity surface");
});

test("SS-03 VisualHarness render installs only its keyed observer surface", async () => {
  const rendered = await renderHarness(
    "http://localhost/?visual=components&surface=ss03",
  );
  const state = useButlerStore.getState();
  const dialog = rendered.document.querySelector('[role="dialog"]');

  expect(state.observerSessionId).toBe("harness-steward");
  expect(state.sessionViews["harness-steward"]?.session_id).toBe(
    "harness-steward",
  );
  expect(state.leftOpen).toBe(true);
  expect(useComposerStore.getState().engaged).toBe(true);
  expect(dialog).not.toBeNull();
  expect(dialog?.getAttribute("role")).toBe("dialog");
  expect(rendered.document.body.textContent).toContain("Review the activity surface");
  expect(rendered.container.textContent).toContain(
    "작업 중 · 2/3 · Inspecting the activity surface",
  );
  expect(dialog?.querySelector('[data-test-class*="composer"]')).toBeNull();
});

async function renderHarness(url: string): Promise<{
  container: HTMLElement;
  document: Document;
}> {
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url,
  });
  const window = dom.window;
  const mediaQuery = {
    matches: false,
    media: "",
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  };
  const ResizeObserverStub = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const requestAnimationFrame = (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0);
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  Object.assign(window, { requestAnimationFrame, cancelAnimationFrame });
  Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => null,
  });
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    SVGElement: window.SVGElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    DocumentFragment: window.DocumentFragment,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    FocusEvent: window.FocusEvent,
    MutationObserver: window.MutationObserver,
    ResizeObserver: ResizeObserverStub,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame,
    cancelAnimationFrame,
    fetch: async () => {
      throw new Error("VisualHarness test transport disabled");
    },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => mediaQuery,
  });
  Object.assign(window.HTMLElement.prototype, {
    attachEvent: () => undefined,
    detachEvent: () => undefined,
    scrollIntoView: () => undefined,
  });
  const container = window.document.querySelector("#root");
  if (!(container instanceof window.HTMLElement)) {
    throw new Error("Missing VisualHarness test root.");
  }
  const { VisualHarness } = await import("./VisualHarness");
  root = createRoot(container);
  await act(async () => root?.render(<VisualHarness />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return { container, document: window.document };
}
