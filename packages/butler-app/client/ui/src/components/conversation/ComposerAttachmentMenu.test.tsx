/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EMPTY_NAVIGATION, EMPTY_SETTINGS } from "@/app/constants.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useComposerStore } from "./composerStore";
import { ComposerAttachmentMenu } from "./ComposerAttachmentMenu";

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
  delete (globalThis as { SVGElement?: unknown }).SVGElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("plus remains the compact popover trigger without an inline drawer", async () => {
  const dom = installDom();
  useButlerStore.setState({
    activeChatId: "draft:project:project-sandy",
    navigation: EMPTY_NAVIGATION,
    settings: EMPTY_SETTINGS,
  });
  useComposerStore.setState({ uploadingCount: 0 });
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root");
  }
  root = createRoot(container);
  await act(async () => root?.render(<ComposerAttachmentMenu />));

  const trigger = container.querySelector<HTMLButtonElement>(
    '[data-test-class="attachment-button"]',
  );
  expect(trigger?.getAttribute("aria-label")).toBe(
    appCopy.composer.featureDrawer,
  );
  expect(trigger?.getAttribute("aria-haspopup")).toBe("dialog");
  expect(trigger?.getAttribute("aria-expanded")).toBe("false");
  expect(
    container.querySelector('[data-test-class="composer-feature-drawer"]'),
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
    SVGElement: dom.window.SVGElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: ResizeObserverStub,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return dom;
}
