export const DEFAULT_LEFT_PANEL_WIDTH = 304;
export const LEFT_PANEL_MIN_WIDTH = 248;
export const LEFT_PANEL_MAX_WIDTH = 420;
export const DEFAULT_RIGHT_PANEL_WIDTH = 376;
export const RIGHT_PANEL_MIN_WIDTH = 292;
export const RIGHT_PANEL_MAX_WIDTH = 520;

export function clampPanelWidth(
  value: number,
  min: number,
  max: number,
): number {
  return Math.min(max, Math.max(min, value));
}
