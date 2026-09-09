export const DEFAULT_LEFT_PANEL_WIDTH = 304;
export const LEFT_PANEL_MIN_WIDTH = 248;
export const LEFT_PANEL_MAX_WIDTH = 420;
export const DEFAULT_RIGHT_PANEL_WIDTH = 376;
export const RIGHT_PANEL_MIN_WIDTH = 292;
export const WORKSPACE_MIN_WIDTH = 320;

/** Persist the preference, not the current viewport's temporary limit. */
export function normalizeRightPanelWidth(value: number): number {
  return Number.isFinite(value) ? Math.max(RIGHT_PANEL_MIN_WIDTH, value) : DEFAULT_RIGHT_PANEL_WIDTH;
}

export function resolvePanelGeometry({ width, leftWidth, rightWidth, leftOpen, drawer }: {
  width: number; leftWidth: number; rightWidth: number; leftOpen: boolean; drawer: boolean;
}) {
  const left = drawer ? leftWidth : Math.min(leftWidth, Math.max(0, width - WORKSPACE_MIN_WIDTH));
  const rightMax = drawer ? width : Math.max(0, width - (leftOpen ? left : 0) - WORKSPACE_MIN_WIDTH);
  const rightMin = Math.min(RIGHT_PANEL_MIN_WIDTH, rightMax);
  return { leftWidth: left, rightWidth: drawer ? rightWidth : clampPanelWidth(rightWidth, rightMin, rightMax), rightMin, rightMax };
}

export function clampPanelWidth(
  value: number,
  min: number,
  max: number,
): number {
  return Math.min(max, Math.max(min, value));
}
