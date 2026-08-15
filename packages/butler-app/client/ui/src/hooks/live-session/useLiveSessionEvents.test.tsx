/// <reference types="bun" />

import { afterEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NavigationView, SessionSummary } from "@/app/types.ts";
import { activeChatFromNavigation } from "@/app/utils.ts";
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
let navigationRefreshCalls = 0;
let navigationRefreshResolver: (() => void) | undefined;
const navigationRefreshSnapshots: NavigationView[] = [];
const navigationSession = (input: {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
  pinned?: boolean;
}): SessionSummary => ({
  id: input.id,
  kind: "project" as const,
  project_id: input.projectId,
  title: input.title,
  created_at: input.createdAt,
  updated_at: input.updatedAt,
  last_activity_at: input.updatedAt,
  pinned: input.pinned ?? false,
  archived: input.archived ?? false,
});
const initialNavigation = (): NavigationView => ({
  chats: [],
  projects: [
    {
      id: "project-one",
      display_name: "Project One",
      last_activity_at: "2026-08-08T00:00:00.000Z",
      pinned: false,
      archived: false,
      sessions: [
        navigationSession({
          id: "session-live-events",
          projectId: "project-one",
          title: "Prompt fallback",
          createdAt: "2026-08-07T00:00:00.000Z",
          updatedAt: "2026-08-08T00:00:00.000Z",
        }),
      ],
    },
    {
      id: "project-two",
      display_name: "Project Two",
      last_activity_at: "2026-08-08T00:00:00.000Z",
      pinned: false,
      archived: false,
      sessions: [],
    },
  ],
  automations_summary: { total_count: 0, enabled_count: 0 },
  settings_summary: { profile_label: "Test" },
});
let applyFailuresRemaining = 0;
let holdRefresh = false;
const refreshResolvers: Array<() => void> = [];
const refreshSnapshots: Array<{ context: string; skills: string[] }> = [];
let latestContext = "";
let latestSkills: string[] = [];
const storeState = {
  activeChatId: "session-live-events",
  navigation: initialNavigation(),
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
  setNavigation(navigation: ReturnType<typeof initialNavigation>) {
    this.navigation = navigation;
  },
  noteNavigationEvent() {
    // The production store fences bootstrap/navigation responses here.
  },
  async refreshNavigation(options?: { isCurrent?: () => boolean }) {
    navigationRefreshCalls += 1;
    if (navigationRefreshResolver) {
      await new Promise<void>((resolve) => {
        navigationRefreshResolver = resolve;
      });
    }
    if (options?.isCurrent?.() === false) return false;
    const snapshot = navigationRefreshSnapshots.shift();
    if (snapshot) this.navigation = snapshot;
    return true;
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
  storeState.activeChatId = "session-live-events";
  storeState.navigation = initialNavigation();
  navigationRefreshCalls = 0;
  navigationRefreshResolver = undefined;
  navigationRefreshSnapshots.splice(0);
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

test("session created and updated events reconcile the visible project session without reload", async () => {
  await renderHarness();
  deliverEvent(0, {
    id: 43,
    type: "session.created",
    created_at: new Date().toISOString(),
    payload: {
      session: navigationSession({
        id: "session-new",
        projectId: "project-one",
        title: "새 세션",
        createdAt: "2026-08-08T00:01:00.000Z",
        updatedAt: "2026-08-08T00:01:00.000Z",
      }),
      private_prompt: "must not enter navigation",
    },
  });
  deliverEvent(0, {
    id: 45,
    type: "session.updated",
    created_at: new Date().toISOString(),
    payload: {
      session: navigationSession({
        id: "session-live-events",
        projectId: "project-one",
        title: "활성 세션 최신 제목",
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-08T00:03:00.000Z",
      }),
    },
  });
  deliverEvent(0, {
    id: 44,
    type: "session.updated",
    created_at: new Date().toISOString(),
    payload: {
      session: navigationSession({
        id: "session-new",
        projectId: "project-one",
        title: "브라우저 부분 캡처 및 화면 필터링 구현",
        createdAt: "2026-08-08T00:01:00.000Z",
        updatedAt: "2026-08-08T00:02:00.000Z",
      }),
    },
  });
  await flushMicrotasks();

  const sessions = storeState.navigation.projects[0]?.sessions ?? [];
  expect(sessions.find((session) => session.id === "session-new")?.title)
    .toBe("브라우저 부분 캡처 및 화면 필터링 구현");
  expect(sessions.filter((session) => session.id === "session-new")).toHaveLength(1);
  expect(JSON.stringify(storeState.navigation)).not.toContain("private_prompt");
  expect(activeChatFromNavigation(storeState.navigation, "session-live-events").title)
    .toBe("활성 세션 최신 제목");
});

test("an empty navigation converges from an owning project event through one bounded refresh", async () => {
  const canonical = initialNavigation();
  canonical.projects = [{
    id: "project-three",
    display_name: "Project Three",
    last_activity_at: "2026-08-08T00:00:00.000Z",
    pinned: false,
    archived: false,
    sessions: [navigationSession({
      id: "session-startup",
      projectId: "project-three",
      title: "생성 제목",
      createdAt: "2026-08-08T00:01:00.000Z",
      updatedAt: "2026-08-08T00:02:00.000Z",
    })],
  }];
  storeState.navigation = { ...initialNavigation(), projects: [] };
  navigationRefreshSnapshots.push(canonical);
  await renderHarness();
  deliverEvent(0, {
    id: 43,
    type: "session.created",
    created_at: new Date().toISOString(),
    payload: {
      session: navigationSession({
        id: "session-startup",
        projectId: "project-three",
        title: "Prompt fallback",
        createdAt: "2026-08-08T00:01:00.000Z",
        updatedAt: "2026-08-08T00:02:00.000Z",
      }),
    },
  });
  await flushMicrotasks();
  expect(navigationRefreshCalls).toBe(1);
  expect(subscriptions).toHaveLength(1);
  expect(storeState.navigation.projects[0]?.sessions?.[0]?.title).toBe("생성 제목");
});

test("an absent session.updated delegates unarchive visibility to one canonical refresh", async () => {
  const canonical = initialNavigation();
  canonical.projects[0]!.sessions = [navigationSession({
    id: "session-unarchive",
    projectId: "project-one",
    title: "최신 복원 제목",
    createdAt: "2026-08-08T00:01:00.000Z",
    updatedAt: "2026-08-08T00:05:00.000Z",
  })];
  navigationRefreshSnapshots.push(canonical);
  await renderHarness();
  deliverEvent(0, {
    id: 43,
    type: "session.updated",
    created_at: new Date().toISOString(),
    payload: {
      session: navigationSession({
        id: "session-unarchive",
        projectId: "project-one",
        title: "오래된 복원",
        createdAt: "2026-08-08T00:01:00.000Z",
        updatedAt: "2026-08-08T00:04:00.000Z",
      }),
    },
  });
  await flushMicrotasks();
  expect(navigationRefreshCalls).toBe(1);
  expect(storeState.navigation.projects[0]?.sessions?.map((session) => session.id))
    .toEqual(["session-unarchive"]);
  expect(storeState.navigation.projects[0]?.sessions?.[0]?.title)
    .toBe("최신 복원 제목");
});

test("reconnect and reconcile-required events refresh canonical navigation through one stream", async () => {
  await renderHarness();
  subscriptions[0]?.onError(new Error("temporary disconnect"));
  await fakeClock?.advanceBy(1_000);
  await flushMicrotasks();
  expect(subscriptions).toHaveLength(2);
  expect(navigationRefreshCalls).toBe(1);

  subscriptions[1]?.onEvent({
    id: 43,
    type: "stream.reconcile_required",
    created_at: new Date().toISOString(),
    payload: {},
  });
  await flushMicrotasks();
  expect(navigationRefreshCalls).toBe(2);
  expect(subscriptions).toHaveLength(2);
});

test("active session switches keep the app-wide navigation stream singular", async () => {
  await renderHarness();
  storeState.activeChatId = "session-other";
  await act(async () => renderedRoot?.render(React.createElement(Harness)));
  expect(subscriptions).toHaveLength(1);
  expect(unsubscribeCalls).toBe(0);
});

test("active session switches do not fence navigation refresh but fence session-view refresh", async () => {
  const canonical = initialNavigation();
  canonical.projects[0]!.sessions = [navigationSession({
    id: "session-unarchive",
    projectId: "project-one",
    title: "네비게이션 최신 제목",
    createdAt: "2026-08-08T00:01:00.000Z",
    updatedAt: "2026-08-08T00:05:00.000Z",
  })];
  navigationRefreshSnapshots.push(canonical);
  holdRefresh = true;
  await renderHarness();
  deliverEvent(0, {
    id: 43,
    type: "message.updated",
    created_at: new Date().toISOString(),
    payload: { message: { chat_id: "session-live-events" } },
  });
  await flushMicrotasks();
  expect(refreshedSessions).toEqual(["session-live-events"]);

  // Make the navigation refresh wait so the active-session switch happens
  // while that app-wide request is in flight.
  navigationRefreshResolver = () => undefined;
  deliverEvent(0, {
    id: 44,
    type: "session.updated",
    created_at: new Date().toISOString(),
    payload: {
      session: navigationSession({
        id: "session-unarchive",
        projectId: "project-one",
        title: "오래된 복원",
        createdAt: "2026-08-08T00:01:00.000Z",
        updatedAt: "2026-08-08T00:04:00.000Z",
      }),
    },
  });
  await flushMicrotasks();
  expect(navigationRefreshCalls).toBe(1);
  expect(storeState.navigation.projects[0]?.sessions?.some(
    (session) => session.id === "session-unarchive",
  )).toBe(false);

  storeState.activeChatId = "session-other";
  await act(async () => renderedRoot?.render(React.createElement(Harness)));
  holdRefresh = false;
  refreshResolvers.shift()?.();
  navigationRefreshResolver?.();
  navigationRefreshResolver = undefined;
  await flushMicrotasks();

  expect(storeState.navigation.projects[0]?.sessions?.[0]?.title)
    .toBe("네비게이션 최신 제목");
  expect(appliedRefreshes).toEqual([]);
});

test("navigation event reconciliation ignores unrelated, stale, archived, and deleted sessions", async () => {
  await renderHarness();
  const unrelated = navigationSession({
    id: "session-other-project",
    projectId: "project-two",
    title: "다른 프로젝트",
    createdAt: "2026-08-08T00:03:00.000Z",
    updatedAt: "2026-08-08T00:03:00.000Z",
  });
  deliverEvent(0, {
    type: "session.created",
    payload: { session: unrelated },
  });
  deliverEvent(0, {
    type: "session.updated",
    payload: {
      session: navigationSession({
        id: unrelated.id,
        projectId: "project-two",
        title: "오래된 제목",
        createdAt: unrelated.created_at!,
        updatedAt: "2026-08-08T00:02:00.000Z",
      }),
    },
  });
  deliverEvent(0, {
    type: "session.updated",
    payload: {
      session: navigationSession({
        id: "session-hidden",
        projectId: "project-one",
        title: "보관된 세션",
        createdAt: "2026-08-08T00:04:00.000Z",
        updatedAt: "2026-08-08T00:04:00.000Z",
        archived: true,
      }),
    },
  });
  deliverEvent(0, {
    type: "session.permanently_deleted",
    payload: { session: { id: "session-live-events" } },
  });
  await flushMicrotasks();

  expect(storeState.navigation.projects[1]?.sessions?.map((session) => session.id))
    .toEqual(["session-other-project"]);
  expect(storeState.navigation.projects[0]?.sessions?.some(
    (session) => session.id === "session-hidden",
  )).toBe(false);
  expect(storeState.navigation.projects[0]?.sessions?.some(
    (session) => session.id === "session-live-events",
  )).toBe(false);
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
