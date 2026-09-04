/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { appCopy } from "@/app/copy.ts";
import { useComposerStore } from "./composerStore";
import { ComposerPlanModeBadge } from "./ComposerPlanModeBadge";

const initialState = useComposerStore.getState();
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  useComposerStore.setState(initialState);
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("plan badge is removable and ordinary mode has no mode marker", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const changes: boolean[] = [];
  useComposerStore.setState({
    planMode: true,
    handlePlanModeChange: (value) => {
      changes.push(value);
      useComposerStore.setState({ planMode: value });
    },
  });
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing root");
  }
  root = createRoot(container);
  await act(async () => root?.render(<ComposerPlanModeBadge />));

  expect(container.textContent).toContain(appCopy.composer.plan);
  const cancel = container.querySelector<HTMLButtonElement>("button");
  expect(cancel?.getAttribute("aria-label")).toBe(
    `${appCopy.composer.plan} ${appCopy.common.cancel}`,
  );
  await act(async () => cancel?.click());
  expect(changes).toEqual([false]);
  expect(container.textContent).toBe("");
});
