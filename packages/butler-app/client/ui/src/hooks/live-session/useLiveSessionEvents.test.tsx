/// <reference types="bun" />

import { afterEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  FakeClock,
  flushMicrotasks,
} from "./liveSessionTestClock.ts";

interface LiveEventHandlers {
  onEvent(event: Record<string, unknown>): void;
  onError(error: unknown): void;
}

const subscriptions: LiveEventHandlers[] = [];
const subscriptionCursors: number[] = [];
let unsubscribeCalls = 0;
const refreshedSessions: string[] = [];
const appliedRefreshes: string[] = [];
const appliedEvents: unknown[] = [];
let applyFailuresRemaining = 0;
let holdRefresh = false;
const refreshResolvers: Array<() => void> = [];
const refreshSnapshots: Array<{ context: string; skills: string[] }> = [];
let latestContext = "";
let latestSkills: string[] = [];
const storeState = {
  activeChatId: "session-live-events",
  sessionView: {
    session_id: "session-live-events",
    active_turn: null as Record<string, unknown> | null,
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
  async refreshSessionView(
    sessionId: string,
    options?: { isCurrent?: () => boolean },
  ) {
    refreshedSessions.push(sessionId);
    if (holdRefresh) {
      await new Promise<void>((resolve) => refreshResolvers.push(resolve));
    }
    if (options?.isCurrent?.() === false) return false;
    appliedRefreshes.push(sessionId);
    const snapshot = refreshSnapshots.shift();
    if (snapshot) {
      latestContext = snapshot.context;
      latestSkills = snapshot.skills;
    }
    return true;
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
let fakeClock: FakeClock | undefined;

afterEach(async () => {
  if (renderedRoot) await act(async () => renderedRoot?.unmount());
  renderedRoot = undefined;
  subscriptions.splice(0);
  subscriptionCursors.splice(0);
  refreshedSessions.splice(0);
  appliedRefreshes.splice(0);
  refreshSnapshots.splice(0);
  latestContext = "";
  latestSkills = [];
  holdRefresh = false;
  refreshResolvers.splice(0).forEach((resolve) => resolve());
  appliedEvents.splice(0);
  applyFailuresRemaining = 0;
  storeState.sessionView.active_turn = null;
  unsubscribeCalls = 0;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
  fakeClock?.uninstall();
  fakeClock = undefined;
});

test("transport errors reconnect without repeatedly refreshing the session view", async () => {
  await renderHarness();
  expect(subscriptions).toHaveLength(1);

  subscriptions[0]?.onError(new Error("temporary disconnect"));
  await flushMicrotasks();
  expect(refreshedSessions).toEqual([]);
  expect(unsubscribeCalls).toBe(1);

  await fakeClock?.advanceBy(999);
  expect(subscriptions).toHaveLength(1);
  await fakeClock?.advanceBy(1);
  expect(subscriptions).toHaveLength(2);
  await flushMicrotasks();
  expect(refreshedSessions).toEqual(["session-live-events"]);

  subscriptions[1]?.onEvent({
    id: 43,
    type: "stream.reconcile_required",
    created_at: new Date().toISOString(),
    payload: {},
  });
  await flushMicrotasks();
  expect(refreshedSessions).toEqual(["session-live-events"]);
  await fakeClock?.advanceBy(999);
  expect(refreshedSessions).toHaveLength(1);
  await fakeClock?.advanceBy(1);
  expect(refreshedSessions).toHaveLength(2);
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
  await flushMicrotasks();
  await fakeClock?.advanceBy(1_000);

  expect(subscriptionCursors).toEqual([42, 42]);
  expect(appliedEvents).toEqual([]);
  deliverEvent(1, event);
  expect(appliedEvents).toEqual([event]);
});

test("relevant active-session events use leading and trailing refreshes", async () => {
  await renderHarness();
  const event = {
    id: 43,
    type: "message.updated",
    created_at: new Date().toISOString(),
    payload: {
      message: { chat_id: "session-live-events" },
    },
  };

  deliverEvent(0, event);
  await flushMicrotasks();
  expect(refreshedSessions).toEqual(["session-live-events"]);

  deliverEvent(0, {
    ...event,
    id: 44,
  });
  await flushMicrotasks();
  expect(refreshedSessions).toHaveLength(1);

  await fakeClock?.advanceBy(999);
  expect(refreshedSessions).toHaveLength(1);
  await fakeClock?.advanceBy(1);
  expect(refreshedSessions).toHaveLength(2);
});

test("a single relevant event causes exactly one refresh", async () => {
  refreshSnapshots.push(
    { context: "context-before-terminal", skills: ["old-skill"] },
    { context: "context-after-terminal", skills: ["latest-skill"] },
  );
  await renderHarness();
  deliverEvent(0, {
    id: 43,
    type: "turn.state_changed",
    created_at: new Date().toISOString(),
    payload: {
      turn: {
        chat_id: "session-live-events",
        state: "cancelled",
      },
    },
  });

  await flushMicrotasks();
  expect(refreshedSessions).toHaveLength(1);
  expect(appliedRefreshes).toHaveLength(1);
  expect(latestContext).toBe("context-before-terminal");
  expect(latestSkills).toEqual(["old-skill"]);

  await fakeClock?.advanceBy(10_000);
  expect(refreshedSessions).toHaveLength(1);
  expect(appliedRefreshes).toHaveLength(1);
});

test("events arriving during a refresh converge with one dirty follow-up", async () => {
  holdRefresh = true;
  await renderHarness();
  const event = {
    id: 43,
    type: "agent.turn_event.progress",
    created_at: new Date().toISOString(),
    payload: {
      session_id: "session-live-events",
      row: { id: "progress-1" },
    },
  };

  deliverEvent(0, event);
  await flushMicrotasks();
  expect(refreshedSessions).toHaveLength(1);

  deliverEvent(0, { ...event, id: 44 });
  await flushMicrotasks();
  expect(refreshedSessions).toHaveLength(1);

  holdRefresh = false;
  refreshResolvers.shift()?.();
  await flushMicrotasks();
  await fakeClock?.advanceBy(999);
  expect(refreshedSessions).toHaveLength(1);
  await fakeClock?.advanceBy(1);
  expect(refreshedSessions).toHaveLength(2);
});

test("healthy idle streams do not poll while an active turn exists", async () => {
  storeState.sessionView.active_turn = {};
  await renderHarness();
  await fakeClock?.advanceBy(60_000);
  expect(refreshedSessions).toHaveLength(0);
  storeState.sessionView.active_turn = null;
});

test("relevant events for an inactive session do not refresh the active view", async () => {
  await renderHarness();
  deliverEvent(0, {
    id: 43,
    type: "progress.summary",
    created_at: new Date().toISOString(),
    payload: {
      session_id: "session-other",
      turn_id: "turn-other",
      row: {
        id: "progress-other",
        state: "running",
        safe_label: "Other session work",
      },
    },
  });
  await flushMicrotasks();
  await fakeClock?.advanceBy(10_000);

  expect(refreshedSessions).toEqual([]);
  expect(appliedEvents).toHaveLength(1);
});

test("disposing the reconciliation invalidates an in-flight refresh result", async () => {
  holdRefresh = true;
  await renderHarness();
  deliverEvent(0, {
    id: 43,
    type: "message.updated",
    created_at: new Date().toISOString(),
    payload: {
      message: { chat_id: "session-live-events" },
    },
  });
  await flushMicrotasks();
  expect(refreshedSessions).toHaveLength(1);

  await act(async () => renderedRoot?.unmount());
  renderedRoot = undefined;
  holdRefresh = false;
  refreshResolvers.shift()?.();
  await flushMicrotasks();

  expect(appliedRefreshes).toEqual([]);
});

async function renderHarness(): Promise<void> {
  fakeClock = new FakeClock();
  fakeClock.install();
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
