/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EMPTY_NAVIGATION, EMPTY_SETTINGS } from "@/app/constants.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useComposerStore } from "./composerStore";

let root: Root | undefined;
const initialButlerState = useButlerStore.getState();
const initialComposerState = useComposerStore.getState();

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  await new Promise((resolve) => setTimeout(resolve, 20));
  useButlerStore.setState(initialButlerState);
  useComposerStore.setState(initialComposerState);
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { Element?: unknown }).Element;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { HTMLButtonElement?: unknown }).HTMLButtonElement;
  delete (globalThis as { SVGElement?: unknown }).SVGElement;
  delete (globalThis as { Node?: unknown }).Node;
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
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("plus opens grouped attachment and response mode options", async () => {
  const dom = installDom();
  const { ComposerAttachmentMenu } = await import("./ComposerAttachmentMenu.tsx");
  useButlerStore.setState({
    activeChatId: "draft:project:project-sandy",
    navigation: EMPTY_NAVIGATION,
    settings: EMPTY_SETTINGS,
  });
  const modeChanges: boolean[] = [];
  useComposerStore.getState().setSnapshot({
    handlePlanModeChange: (checked) => {
      modeChanges.push(checked);
      useComposerStore.getState().setSnapshot({ planMode: checked });
    },
    planMode: false,
    uploadingCount: 0,
  });

  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  root = createRoot(container);
  await act(async () => root?.render(<ComposerAttachmentMenu />));

  const trigger = container.querySelector(
    '[data-test-class="attachment-button"]',
  );
  if (!(trigger instanceof dom.window.HTMLButtonElement)) {
    throw new Error("Missing attachment trigger.");
  }
  await act(async () => {
    trigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  const titles = Array.from(
    dom.window.document.querySelectorAll('[data-slot="option-menu-section-title"]'),
  ).map((element) => element.textContent);
  expect(titles).toEqual([
    appCopy.composer.attachments,
    appCopy.composer.responseMode,
  ]);
  const item = (label: string) =>
    Array.from(
      dom.window.document.querySelectorAll('[data-slot="option-menu-item"]'),
    ).find((element) => element.textContent?.includes(label));
  expect(item(appCopy.composer.normal)?.getAttribute("data-selected")).toBe(
    "true",
  );
  expect(item(appCopy.composer.plan)?.getAttribute("data-selected")).toBeNull();

  const plan = item(appCopy.composer.plan);
  if (!(plan instanceof dom.window.HTMLButtonElement)) {
    throw new Error("Missing plan option.");
  }
  await act(async () => {
    plan.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  expect(modeChanges).toEqual([true]);
  expect(dom.window.document.querySelector('[data-slot="popover-content"]')).toBeNull();

  await act(async () => {
    trigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const content = dom.window.document.querySelector('[data-slot="popover-content"]');
  if (!(content instanceof dom.window.HTMLElement)) {
    throw new Error("Missing feature drawer.");
  }
  await act(async () => {
    content.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(dom.window.document.querySelector('[data-slot="popover-content"]')).toBeNull();
});

test("file attachment remains a direct drawer action and closes the drawer", async () => {
  const dom = installDom();
  const { ComposerAttachmentMenu } = await import("./ComposerAttachmentMenu.tsx");
  useButlerStore.setState({
    activeChatId: "draft:chat",
    navigation: EMPTY_NAVIGATION,
    settings: EMPTY_SETTINGS,
  });
  let pickerCalls = 0;
  useComposerStore.getState().setSnapshot({
    openAttachmentPicker: () => {
      pickerCalls += 1;
    },
    planMode: true,
    uploadingCount: 0,
  });

  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  root = createRoot(container);
  await act(async () => root?.render(<ComposerAttachmentMenu />));
  const trigger = container.querySelector(
    '[data-test-class="attachment-button"]',
  );
  if (!(trigger instanceof dom.window.HTMLButtonElement)) {
    throw new Error("Missing attachment trigger.");
  }
  await act(async () => {
    trigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  const file = Array.from(
    dom.window.document.querySelectorAll('[data-slot="option-menu-item"]'),
  ).find((element) => element.textContent?.includes(appCopy.composer.attachFile));
  if (!(file instanceof dom.window.HTMLButtonElement)) {
    throw new Error("Missing file attachment option.");
  }
  await act(async () => {
    file.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  expect(pickerCalls).toBe(1);
  expect(dom.window.document.querySelector('[data-slot="popover-content"]')).toBeNull();
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
    SVGElement: dom.window.SVGElement,
    Node: dom.window.Node,
    DocumentFragment: dom.window.DocumentFragment,
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
