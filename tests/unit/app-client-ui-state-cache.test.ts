import { expect, test } from "bun:test";
import {
  freshAppUiPanelState,
  snapshotForAppUiState,
} from "../../packages/butler-app/client/ui/src/app/appUiStateCache.ts";
import { useButlerStore } from "../../packages/butler-app/client/ui/src/app/store.ts";

test("app UI state cache clamps panel widths and deduplicates collapsed groups", () => {
  const snapshot = snapshotForAppUiState({
    active_session_id: "project-session-a",
    left_open: false,
    right_open: true,
    right_tab: "artifacts",
    left_panel_width: 999,
    right_panel_width: 1,
    sidebar_chats_collapsed: true,
    sidebar_projects_collapsed: true,
    sidebar_collapsed_project_ids: ["project-a", "project-a", "", "project-b"],
  });

  expect(snapshot.schema).toBe("butler.app-ui-state.v1");
  expect(snapshot.active_session_id).toBe("project-session-a");
  expect(snapshot.left_open).toBe(false);
  expect(snapshot.right_tab).toBe("artifacts");
  expect(snapshot.left_panel_width).toBe(420);
  expect(snapshot.right_panel_width).toBe(292);
  expect(snapshot.sidebar_collapsed_project_ids).toEqual([
    "project-a",
    "project-b",
  ]);
});

test("app UI state cache defaults fresh state to an open sidebar and a closed inspector", () => {
  const snapshot = snapshotForAppUiState({});

  expect(snapshot.left_open).toBe(true);
  expect(snapshot.right_open).toBe(false);
  expect(snapshot.active_session_id).toBe("draft:chat");
});

test("a saved inspector choice wins over the closed default", () => {
  expect(snapshotForAppUiState({ right_open: true }).right_open).toBe(true);
  expect(snapshotForAppUiState({ right_open: false }).right_open).toBe(false);
});

test("new users start with the inspector closed", () => {
  expect(useButlerStore.getInitialState().rightOpen).toBe(false);
  expect(useButlerStore.getInitialState().rightTab).toBe("summary");
  expect(freshAppUiPanelState("expanded", useButlerStore.getInitialState().rightOpen).rightOpen).toBe(false);
});

test("a saved sidebar choice wins over the fresh default", () => {
  expect(snapshotForAppUiState({ left_open: false }).left_open).toBe(false);
  expect(snapshotForAppUiState({ left_open: true }).left_open).toBe(true);
});

test("fresh installs open the sidebar only at expanded widths", () => {
  expect(freshAppUiPanelState("expanded", true).leftOpen).toBe(true);
  expect(freshAppUiPanelState("expanded", true).rightOpen).toBe(true);
  expect(freshAppUiPanelState("medium", true).leftOpen).toBe(false);
  expect(freshAppUiPanelState("compact", true).leftOpen).toBe(false);
});
