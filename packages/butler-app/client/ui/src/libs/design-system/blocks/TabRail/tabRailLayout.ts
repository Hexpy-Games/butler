/**
 * TabRail geometry (plan-background-browser-rail §2). The mode follows the
 * container's width (the conversation card, so the sidebar and inspector
 * count), never the window's. ConversationShell's column shift uses the
 * same breakpoints (ConversationShell.module.css container queries).
 */
export type TabRailMode = "full" | "compact" | "shelf";

/** Full rail (208px cards with a title row) from this container width. */
export const TAB_RAIL_FULL_MIN_WIDTH = 960;
/** Compact rail (128×80 thumbnails) from this width; below it the shelf. */
export const TAB_RAIL_COMPACT_MIN_WIDTH = 720;
/** A container shorter than this shows one card fewer. */
export const TAB_RAIL_SHORT_HEIGHT = 600;
/** Cards shown before the rest collapse into "+N". */
export const TAB_RAIL_MAX = 3;

export function tabRailMode(width: number): TabRailMode {
  if (width >= TAB_RAIL_FULL_MIN_WIDTH) return "full";
  return width >= TAB_RAIL_COMPACT_MIN_WIDTH ? "compact" : "shelf";
}

/** How many cards show: `max` (3), or one fewer in a short container; never below 1. */
export function tabRailCap(height: number, max = TAB_RAIL_MAX): number {
  return Math.max(1, height < TAB_RAIL_SHORT_HEIGHT ? max - 1 : max);
}

/** The cards that show and the rest, in the owner's order. */
export function splitRailTabs<T>(tabs: readonly T[], cap: number): { shown: T[]; hidden: T[] } {
  return { shown: tabs.slice(0, cap), hidden: tabs.slice(cap) };
}

/**
 * Where the conversation column goes beside a full or compact rail, in px:
 * it keeps its width and centring and moves left only as far as it must to
 * stay `clearance` clear of the rail; when even its left edge would come
 * within `clearance` of the card's edge, it narrows instead. Mirrors the CSS
 * in ConversationShell.module.css (used by tests and smokes).
 */
export function railColumn({ width, column, rail, inset = 16, clearance = 24 }: {
  width: number; column: number; rail: number; inset?: number; clearance?: number;
}): { left: number; width: number; shift: number } {
  const keepOut = inset + rail + clearance;
  const fitted = Math.min(column, width - keepOut - clearance);
  const centred = (width - fitted) / 2;
  const shift = Math.max(0, keepOut - centred);
  return { left: centred - shift, width: fitted, shift };
}
