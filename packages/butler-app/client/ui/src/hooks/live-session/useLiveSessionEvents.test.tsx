/// <reference types="bun" />

import { afterEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

interface LiveEventHandlers {
  onEvent(event: Record<string, unknown>): void;
  onError(error: unknown): void;
}

const subscriptions: LiveEventHandlers[] = [];
const subscriptionCursors: number[] = [];
let unsubscribeCalls = 0;
const refreshedSessions: string[] = [];
const appliedEvents: unknown[] = [];
let applyFailuresRemaining = 0;
const storeState = {
  activeChatId: "session-live-events",
  sessionView: {
    session_id: "session-live-events",
    cursors: { events: 42 },
  },
  settings: {
    desktop_notifications: {
      enabled: false,
      assistant_messages: false,
      task_completions: false,
    },
  },
  applyTimelineEvents(events: unknown[]) {
    if (applyFailuresRemaining > 0) {
      applyFailuresRemaining -= 1;
      throw new Error("projection failed");
    }
    appliedEvents.push(...events);
  },
  async refreshSessionView(sessionId: string) {
    refreshedSessions.push(sessionId);
  },
};

mock.module("@/app/api.ts", () => ({
  subscribeLiveEvents(
    cursor: number,
    onEvent: LiveEventHandlers["onEvent"],
    onError: LiveEventHandlers["onError"],
  ) {
    subscriptionCursors.push(cursor);
    subscriptions.push({ onEvent, onError });
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      unsubscribeCalls += 1;
    };
  },
}));

mock.module("@/app/nativeNotifications.ts", () => ({
  showDesktopNotification: async () => undefined,
}));

mock.module("@/app/sessionIds.ts", () => ({
  isServerBackedSessionId: () => true,
}));

function selectStore<T>(selector: (state: typeof storeState) => T): T {
  return selector(storeState);
}

const useButlerStore = Object.assign(selectStore, {
  getState: () => storeState,
});

mock.module("@/app/store.ts", () => ({ useButlerStore }));

const { useLiveSessionEvents } = await import("./useLiveSessionEvents.ts");

let renderedRoot: Root | undefined;

afterEach(async () => {
  if (renderedRoot) await act(async () => renderedRoot?.unmount());
  renderedRoot = undefined;
  subscriptions.splice(0);
  subscriptionCursors.splice(0);
  refreshedSessions.splice(0);
  appliedEvents.splice(0);
  applyFailuresRemaining = 0;
  unsubscribeCalls = 0;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("transport errors reconnect without repeatedly refreshing the session view", async () => {
  await renderHarness();
  expect(subscriptions).toHaveLength(1);

  subscriptions[0]?.onError(new Error("temporary disconnect"));
  await Bun.sleep(150);
  expect(refreshedSessions).toEqual([]);
  expect(unsubscribeCalls).toBe(1);

  await Bun.sleep(950);
  expect(subscriptions).toHaveLength(2);
  subscriptions[1]?.onEvent({
    id: 43,
    type: "stream.reconcile_required",
    created_at: new Date().toISOString(),
    payload: {},
  });
  await Bun.sleep(125);
  expect(refreshedSessions).toEqual(["session-live-events"]);
  expect(appliedEvents).toEqual([]);
});

test("projection failures reconnect from the last successfully applied cursor", async () => {
  await renderHarness();
  applyFailuresRemaining = 1;
  const event = {
    id: 43,
    type: "message.created",
    created_at: new Date().toISOString(),
    payload: {},
  };

  deliverEvent(0, event);
  await Bun.sleep(1_100);

  expect(subscriptionCursors).toEqual([42, 42]);
  expect(appliedEvents).toEqual([]);
  deliverEvent(1, event);
  expect(appliedEvents).toEqual([event]);
});

async function renderHarness(): Promise<void> {
  const dom = new JSDOM("<div id=\"root\"></div>", {
    url: "http://127.0.0.1:5173",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = dom.window.document.getElementById("root");
  if (!container) throw new Error("Missing test root.");
  renderedRoot = createRoot(container);
  await act(async () => renderedRoot?.render(React.createElement(Harness)));
}

function deliverEvent(index: number, event: Record<string, unknown>): void {
  const subscription = subscriptions[index];
  if (!subscription) throw new Error(`Missing subscription ${index}.`);
  try {
    subscription.onEvent(event);
  } catch (error) {
    subscription.onError(error);
  }
}

function Harness(): null {
  useLiveSessionEvents();
  return null;
}
