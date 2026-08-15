/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useButlerStore } from "@/app/store.ts";
import type { NavigationView, ProjectDashboardView, ProjectSummary } from "@/app/types.ts";
import { useProjectDashboard } from "./useProjectDashboard.ts";

let resolveDashboard: ((value: ProjectDashboardView) => void) | undefined;
const initialStoreState = useButlerStore.getState();

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  resolveDashboard = undefined;
  useButlerStore.setState({
    navigation: initialStoreState.navigation,
    view: initialStoreState.view,
  });
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("project dashboard sessions stay on navigation after a stale dashboard response", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.butlerApp = {
    getProjectDashboard: async () => await new Promise<ProjectDashboardView>((resolve) => {
      resolveDashboard = resolve;
    }),
  };
  useButlerStore.setState({
    view: { kind: "project-dashboard", projectId: "project-live" },
    navigation: navigation(),
  });
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) throw new Error("Missing root.");
  root = createRoot(container);
  let latestSessions: string[] = [];
  const staleDashboard = dashboard([session("session-live", "Prompt fallback")]);
  await act(async () => {
    root?.render(
      <Harness
        initialDashboard={staleDashboard}
        onSessions={(sessions) => { latestSessions = sessions.map((session) => session.title); }}
      />,
    );
  });
  await act(async () => {
    useButlerStore.setState({
      navigation: navigation([
        session("session-live", "최신 생성 제목"),
        session("session-new", "신규 세션"),
      ]),
    });
  });
  await act(async () => {
    root?.render(
      <Harness
        initialDashboard={staleDashboard}
        onSessions={(sessions) => { latestSessions = sessions.map((session) => session.title); }}
      />,
    );
  });
  expect(latestSessions).toEqual(["최신 생성 제목", "신규 세션"]);
  resolveDashboard?.(staleDashboard);
  await act(async () => Promise.resolve());
  expect(latestSessions).toEqual(["최신 생성 제목", "신규 세션"]);
});

function Harness({
  initialDashboard,
  onSessions,
}: {
  initialDashboard: ProjectDashboardView;
  onSessions: (sessions: ProjectSummary["sessions"] extends infer T ? NonNullable<T> : never) => void;
}) {
  const value = useProjectDashboard({ initialDashboard });
  useEffect(() => {
    onSessions(value.sessions);
  }, [onSessions, value.sessions]);
  return null;
}

function navigation(sessions: ProjectSummary["sessions"] = [session("session-live", "Prompt fallback")]): NavigationView {
  return {
    chats: [],
    projects: [{
      id: "project-live",
      display_name: "Live project",
      last_activity_at: "2026-08-08T00:00:00.000Z",
      pinned: false,
      archived: false,
      sessions,
    }],
    automations_summary: { total_count: 0, enabled_count: 0 },
    settings_summary: { profile_label: "Test" },
  };
}

function session(id: string, title: string) {
  return {
    id,
    kind: "project" as const,
    project_id: "project-live",
    title,
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:01:00.000Z",
    last_activity_at: "2026-08-08T00:01:00.000Z",
    pinned: false,
    archived: false,
  };
}

function dashboard(sessions: NonNullable<ProjectSummary["sessions"]>): ProjectDashboardView {
  return {
    project: {
      ...navigation(sessions).projects[0]!,
      sessions,
    },
    stats: {
      active_sessions: sessions.length,
      archived_sessions: 0,
      recent_messages_7d: 0,
      recent_messages_30d: 0,
      specs: 0,
      plans: 0,
    },
    activity: { days: [] },
    documents: [],
    generated_at: "2026-08-08T00:00:00.000Z",
  };
}
