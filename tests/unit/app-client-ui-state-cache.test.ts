// test-category: pure-logic
import { describe, expect, test } from "bun:test";
import { freshAppUiPanelState, snapshotForAppUiState } from "../../packages/butler-app/client/ui/src/app/appUiStateCache.ts";
import { resolvePanelGeometry } from "../../packages/butler-app/client/ui/src/app/panelSizing";
import { useButlerStore } from "../../packages/butler-app/client/ui/src/app/store.ts";

describe("app-client-ui-state-cache.test.ts", () => {
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
});

describe("app-panel-sizing.test.ts", () => {
test("right panel can fill the shell up to the 320px conversation boundary", () => {
  const input = { width: 1440, leftWidth: 304, rightWidth: 2000, leftOpen: true, drawer: false };
  expect(resolvePanelGeometry(input)).toEqual({ leftWidth: 304, rightWidth: 816, rightMin: 292, rightMax: 816 });
  expect(resolvePanelGeometry({ ...input, leftOpen: false }).rightWidth).toBe(1120);
  expect(resolvePanelGeometry({ ...input, width: 1920 }).rightWidth).toBe(1296);
  expect(resolvePanelGeometry({ ...input, rightWidth: 400 }).rightWidth).toBe(400);
});

test("narrow docked windows preserve the main region; drawers do not shrink it", () => {
  const input = { width: 641, leftWidth: 420, rightWidth: 1200, leftOpen: true, drawer: false };
  const result = resolvePanelGeometry(input);
  expect(input.width - result.leftWidth - result.rightWidth).toBe(320);
  expect(result.rightMin).toBeLessThanOrEqual(result.rightMax);
  expect(resolvePanelGeometry({ ...input, drawer: true }).rightWidth).toBe(1200);
});

test("cache keeps wide panel preferences across restoration and rejects non-finite widths", () => {
  expect(snapshotForAppUiState({ right_panel_width: 1100 }).right_panel_width).toBe(1100);
  expect(snapshotForAppUiState({ right_panel_width: Number.NaN }).right_panel_width).toBe(376);
  expect(snapshotForAppUiState({ right_panel_width: Infinity }).right_panel_width).toBe(376);
});
});
