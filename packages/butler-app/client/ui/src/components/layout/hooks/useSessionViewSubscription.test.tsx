/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSessionViewSubscription, refreshSessionViewSubscriptions } from "./useSessionViewSubscription";

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

test("session view hook shares an initial read and coalesces live events without idle polling", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
  });
  let requests = 0;
  let releaseFirstRequest: (() => void) | undefined;
  const refresh = () => {
    requests++;
    if (requests === 1) return new Promise<void>(resolve => { releaseFirstRequest = resolve; });
  };
  root = createRoot(dom.window.document.querySelector("#root")!);
  await act(async () => root?.render(<><Harness refresh={refresh} /><Harness refresh={refresh} /></>));
  expect(requests).toBe(1);
  const event = { type: "subsession.changed", payload: { child_session_id: "steward-1" } };
  await act(async () => {
    refreshSessionViewSubscriptions(event);
    refreshSessionViewSubscriptions(event);
  });
  expect(requests).toBe(1);
  releaseFirstRequest?.();
  await act(async () => Promise.resolve());
  expect(requests).toBe(2);
  await act(async () => Promise.resolve());
  expect(requests).toBe(2);
  await act(async () => root?.unmount());
  root = undefined;
  refreshSessionViewSubscriptions(event);
  await act(async () => Promise.resolve());
  expect(requests).toBe(2);
});

function Harness({
  refresh,
}: {
  refresh: (sessionId: string) => Promise<unknown> | unknown;
}) {
  useSessionViewSubscription("steward-1", refresh);
  return null;
}
