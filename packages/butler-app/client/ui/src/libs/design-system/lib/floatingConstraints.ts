export const TITLEBAR_SAFE_AREA_TOP_PX = 56;
export const TITLEBAR_MENU_SIDE_OFFSET_PX = 18;

export const floatingContentCollisionPadding = {
  top: TITLEBAR_SAFE_AREA_TOP_PX,
  right: 8,
  bottom: 8,
  left: 8,
} as const;

export function clampToTitlebarSafeTop(top: number): number {
  return Math.max(top, TITLEBAR_SAFE_AREA_TOP_PX);
}
