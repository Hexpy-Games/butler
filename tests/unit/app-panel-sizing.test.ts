import { expect, test } from "bun:test";
import { resolvePanelGeometry } from "../../packages/butler-app/client/ui/src/app/panelSizing";
import { snapshotForAppUiState } from "../../packages/butler-app/client/ui/src/app/appUiStateCache";

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
