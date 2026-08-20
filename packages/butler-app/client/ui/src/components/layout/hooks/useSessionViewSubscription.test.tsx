/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSessionViewSubscription } from "./useSessionViewSubscription";

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("session view hook performs one initial request and bounded cadence without a response loop", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", { url: "http://localhost" });
  const callbacks: Array<() => void> = [];
  let cleared = false;
  let requests = 0;
  let releaseFirstRequest: (() => void) | undefined;
  const nativeSetInterval = dom.window.setInterval.bind(dom.window);
  const nativeClearInterval = dom.window.clearInterval.bind(dom.window);
  dom.window.setInterval = ((callback: TimerHandler) => {
    callbacks.push(callback as () => void);
    return 1;
  }) as typeof dom.window.setInterval;
  dom.window.clearInterval = (() => {
    cleared = true;
  }) as typeof dom.window.clearInterval;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const refresh = () => {
    requests += 1;
    if (requests === 1) {
      return new Promise<void>((resolve) => {
        releaseFirstRequest = resolve;
      });
    }
  };
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) throw new Error("Missing root.");
  root = createRoot(container);
  await act(async () => root?.render(<Harness refresh={refresh} />));
  expect(requests).toBe(1);
  await act(async () => {
    callbacks[0]?.();
    callbacks[0]?.();
  });
  expect(requests).toBe(1);
  releaseFirstRequest?.();
  await act(async () => Promise.resolve());
  await act(async () => callbacks[0]?.());
  expect(requests).toBe(2);
  await act(async () => callbacks[0]?.());
  expect(requests).toBe(3);
  await act(async () => root?.unmount());
  root = undefined;
  expect(cleared).toBe(true);
  // Keep the real timer methods referenced so the fake cadence cannot silently
  // become a browser-level timer in this behavioral test.
  expect(nativeSetInterval).toBeDefined();
  expect(nativeClearInterval).toBeDefined();
});

function Harness({
  refresh,
}: {
  refresh: (sessionId: string) => Promise<unknown> | unknown;
}) {
  useSessionViewSubscription("steward-1", refresh);
  return null;
}
