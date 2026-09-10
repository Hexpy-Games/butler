/// <reference types="bun" />

import { expect, test } from "bun:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { useComposerStore } from "./composerStore";
import { ComposerToolbar } from "./ComposerToolbar";
import { useButlerStore } from "@/app/store.ts";

test("composer toolbar keeps stable left and right control groups", () => {
  const before = useComposerStore.getState();
  useComposerStore.setState({ planMode: true });
  const html = renderToStaticMarkup(<ComposerToolbar />);
  useComposerStore.setState(before);

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
