/// <reference types="bun" />

import { expect, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { useComposerStore } from "./composerStore";
import { ComposerToolbar } from "./ComposerToolbar";
import { useButlerStore } from "@/app/store.ts";

async function renderToolbarHtml(state: Partial<ReturnType<typeof useComposerStore.getState>>) {
  const before = useComposerStore.getState();
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator, HTMLElement: globalThis.HTMLElement };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(async () => {
      useComposerStore.setState(state);
      root.render(<ComposerToolbar />);
    });
    return container.innerHTML;
  } finally {
    await act(async () => root.unmount());
    useComposerStore.setState(before);
    Object.assign(globalThis, globals, { IS_REACT_ACT_ENVIRONMENT: false });
    dom.window.close();
  }
}

const CONTEXT_FIXTURE = { ratio: 0.25, used_tokens: 250, budget_tokens: 1000 } as never;

test("composer toolbar keeps stable left and right control groups", async () => {
  const html = await renderToolbarHtml({ planMode: true, context: CONTEXT_FIXTURE });

  const plus = html.indexOf('data-test-class="attachment-button"');
  const access = html.indexOf('data-test-class="access-button"');
  const spacer = html.indexOf('data-test-class="composer-toolbar-spacer"');
  const context = html.indexOf('data-test-class="context-donut-button"');
  const model = html.indexOf('data-test-class="model-button"');
  const send = html.indexOf('data-test-class="composer-send-button"');

  expect(plus).toBeGreaterThanOrEqual(0);
  expect(access).toBeGreaterThanOrEqual(0);
  expect(spacer).toBeGreaterThanOrEqual(0);
  expect(context).toBeGreaterThanOrEqual(0);
  expect(model).toBeGreaterThanOrEqual(0);
  expect(send).toBeGreaterThanOrEqual(0);
  expect(plus).toBeLessThan(access);
  expect(access).toBeLessThan(spacer);
  expect(spacer).toBeLessThan(context);
  expect(context).toBeLessThan(model);
  expect(model).toBeLessThan(send);
});

test("reconnection overrides send and stop with a disabled busy control, then restores normal state", async () => {
  const before = useComposerStore.getState();
  const appBefore = useButlerStore.getState().liveConnectionLost;
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator, HTMLElement: globalThis.HTMLElement };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.getElementById("root")!;
  const root = createRoot(container);
  try {
    for (const activeTurn of [false, true]) {
      await act(async () => {
        useComposerStore.setState({ activeTurn, canStop: true, canSend: false });
        useButlerStore.setState({ liveConnectionLost: true });
        root.render(<ComposerToolbar />);
      });
      const html = container.innerHTML;
      expect(html).toContain('aria-busy="true"');
      expect(html).toMatch(/data-test-class="composer-send-button"[^>]*disabled=""/);
      expect(html).toMatch(/data-test-class="composer-send-button"[^>]*type="button"/);
    }
    await act(async () => useButlerStore.setState({ liveConnectionLost: false }));
    const recovered = container.innerHTML;
    expect(recovered).not.toContain('aria-busy="true"');
    expect(recovered).toContain('data-test-class="composer-send-button"');
  } finally {
    await act(async () => root.unmount());
    useComposerStore.setState(before);
    useButlerStore.setState({ liveConnectionLost: appBefore });
    Object.assign(globalThis, globals, { IS_REACT_ACT_ENVIRONMENT: false });
    dom.window.close();
  }
});

test("context ring renders only once context usage data exists", async () => {
  expect(await renderToolbarHtml({ context: null })).not.toContain(
    'data-test-class="context-donut-button"',
  );
  expect(await renderToolbarHtml({ context: CONTEXT_FIXTURE })).toContain(
    'data-test-class="context-donut-button"',
  );
});

test("model status error uses the danger tone, an alert icon, and a tooltip hint", async () => {
  const { ComposerModelStatusButton } = await import("./ComposerModelStatusButton");
  const { AlertCircle } = await import("@/butler-ds");
  const { appCopy } = await import("@/app/copy.ts");
  const error = new JSDOM(renderToStaticMarkup(
    <ComposerModelStatusButton state="error" />,
  )).window.document.querySelector<HTMLElement>('[data-test-class~="model-button"]')!;
  expect(error.getAttribute("data-tone")).toBe("danger");
  expect(error.innerHTML).toContain(renderToStaticMarkup(<AlertCircle size={14} />));
  expect(error.getAttribute("aria-label")).toContain(appCopy.composer.modelErrorHint);
  expect(error.hasAttribute("disabled")).toBe(false);
  expect(error.getAttribute("aria-disabled")).toBe("true");

  const loading = new JSDOM(renderToStaticMarkup(
    <ComposerModelStatusButton state="loading" />,
  )).window.document.querySelector<HTMLElement>('[data-test-class~="model-button"]')!;
  expect(loading.getAttribute("data-tone")).toBeNull();
  expect(loading.hasAttribute("disabled")).toBe(true);
});

test("the workspace chip sits in the toolbar after the access control, never floating above the card", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
  const toolbar = read("./ComposerToolbar.tsx");
  const access = toolbar.indexOf("<AccessModeMenu />");
  const workspace = toolbar.indexOf("<ComposerWorkspaceSelect />");
  const spacer = toolbar.indexOf("<ComposerCardToolbarSpacer />");
  expect(access).toBeGreaterThan(0);
  expect(workspace).toBeGreaterThan(access);
  expect(workspace).toBeLessThan(spacer);
  expect(read("./ComposerWorkspaceSelect.tsx")).toContain('data-test-class="composer-workspace-select"');
  expect(read("./ComposerNotices.tsx")).not.toContain("ComposerWorkspaceSelect");
});
