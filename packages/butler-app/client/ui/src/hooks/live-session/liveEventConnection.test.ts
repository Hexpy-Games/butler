// test-category: race
/// <reference types="bun" />

import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createLiveEventConnection } from "./liveEventConnection.ts";

test("an agent resume reconnects a lost live connection without waiting for backoff", () => {
  const dom = new JSDOM("");
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  const subscriptions: Array<{ onError: (error: unknown) => void; onOpen?: () => void }> = [];
  Object.assign(dom.window, {
    butlerApp: {
      subscribeLiveEvents: (
        _input: unknown,
        handlers: { onError: (error: unknown) => void; onOpen?: () => void },
      ) => {
        subscriptions.push(handlers);
        return () => undefined;
      },
    },
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
  });
  let resume: (() => void) | undefined;
  let resumeUnsubscribed = false;
  try {
    const dispose = createLiveEventConnection({
      cursor: () => 0,
      onEvent: () => undefined,
      onLostChange: () => undefined,
      onRecovered: () => undefined,
      subscribeResume: (handler) => {
        resume = handler;
        return () => {
          resumeUnsubscribed = true;
        };
      },
    });
    expect(subscriptions).toHaveLength(1);
    subscriptions[0]!.onError(new Error("agent stopped"));
    expect(subscriptions).toHaveLength(1);

    resume!();
    expect(subscriptions).toHaveLength(2);

    subscriptions[1]!.onOpen?.();
    resume!();
    expect(subscriptions).toHaveLength(2);

    dispose();
    expect(resumeUnsubscribed).toBe(true);
  } finally {
    Object.assign(globalThis, saved);
    dom.window.close();
  }
});
