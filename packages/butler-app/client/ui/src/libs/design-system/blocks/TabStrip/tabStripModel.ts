/** Per-tab activity shown in the favicon slot. */
export type TabStripTabState = "loading" | "working" | "crashed";
/** Group-level attention shown on the group chip. */
export type TabStripGroupState = "working" | "waiting" | "crashed";
/** `mine`: tabs the user opened. `conversation`: tabs a conversation (or its agent) opened; muted. */
export type TabStripGroupKind = "mine" | "conversation";

export interface TabStripTab {
  id: string;
  /** Page title; an empty title reads `labels.untitled`. */
  title: string;
  /** Site icon URL; falls back to a globe when missing or broken. */
  faviconSrc?: string;
  state?: TabStripTabState;
  /** Defaults to true. */
  closable?: boolean;
}

export interface TabStripGroup {
  id: string;
  kind: TabStripGroupKind;
  /** Conversation title; the `mine` group reads `labels.myTabs` when omitted. */
  label?: string;
  tabs: TabStripTab[];
  /** Folded groups show only their chip. */
  collapsed?: boolean;
  state?: TabStripGroupState;
}

/** A tab's new place: `index` is its final position inside the target group. */
export interface TabStripMove {
  tabId: string;
  fromGroupId: string;
  toGroupId: string;
  index: number;
}

/** One focusable stop of the strip, in visual order. */
export type TabStripItem =
  | { key: string; kind: "chip"; groupId: string }
  | { key: string; kind: "tab"; groupId: string; tabId: string };

export const tabKey = (tabId: string) => `tab:${tabId}`;
export const chipKey = (groupId: string) => `chip:${groupId}`;

/**
 * The `mine` group shows its chip only beside other groups. `hideChip` drops the chip of a lone group
 * of any kind (a conversation's own pane, whose title bar already names it).
 */
export function showsChip(group: TabStripGroup, groups: readonly TabStripGroup[], hideChip = false): boolean {
  if (hideChip && groups.length === 1) return false;
  return group.kind !== "mine" || groups.length > 1;
}

export function stripItems(groups: readonly TabStripGroup[], hideChip = false): TabStripItem[] {
  return groups.flatMap((group): TabStripItem[] => [
    ...(showsChip(group, groups, hideChip) ? [{ key: chipKey(group.id), kind: "chip" as const, groupId: group.id }] : []),
    ...(group.collapsed ? [] : group.tabs.map((tab) => ({ key: tabKey(tab.id), kind: "tab" as const, groupId: group.id, tabId: tab.id }))),
  ]);
}

export type TabStripNavKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

/** Roving focus target: arrows wrap, Home/End jump to the ends. */
export function nextFocusKey(items: readonly TabStripItem[], current: string, key: TabStripNavKey): string | null {
  if (items.length === 0) return null;
  if (key === "Home") return items[0]!.key;
  if (key === "End") return items[items.length - 1]!.key;
  const index = items.findIndex((item) => item.key === current);
  const step = key === "ArrowRight" ? 1 : -1;
  return items[(index + step + items.length) % items.length]!.key;
}

/** Where focus goes when a tab closes: the next stop, else the previous one. */
export function focusAfterClose(items: readonly TabStripItem[], key: string): string | null {
  const index = items.findIndex((item) => item.key === key);
  if (index < 0) return null;
  return items[index + 1]?.key ?? items[index - 1]?.key ?? null;
}

export function locateTab(groups: readonly TabStripGroup[], tabId: string) {
  for (const [groupIndex, group] of groups.entries()) {
    const index = group.tabs.findIndex((tab) => tab.id === tabId);
    if (index >= 0) return { group, groupIndex, index, tab: group.tabs[index]! };
  }
  return null;
}

/** Keyboard move by one slot; past a group's edge the tab joins the neighbor group. */
export function moveTabByStep(groups: readonly TabStripGroup[], tabId: string, step: -1 | 1): TabStripMove | null {
  const at = locateTab(groups, tabId);
  if (!at) return null;
  const base = { tabId, fromGroupId: at.group.id };
  const inside = at.index + step;
  if (inside >= 0 && inside < at.group.tabs.length) return { ...base, toGroupId: at.group.id, index: inside };
  const neighbor = groups[at.groupIndex + step];
  if (!neighbor) return null;
  return { ...base, toGroupId: neighbor.id, index: step < 0 ? neighbor.tabs.length : 0 };
}

/** Pointer drop on a tab (takes its slot) or on a group chip (joins the group's end). */
export function moveTabOnDrop(groups: readonly TabStripGroup[], tabId: string, overKey: string): TabStripMove | null {
  const at = locateTab(groups, tabId);
  if (!at) return null;
  const chipTarget = groups.find((group) => chipKey(group.id) === overKey);
  if (chipTarget) {
    const index = chipTarget.tabs.filter((tab) => tab.id !== tabId).length;
    if (chipTarget.id === at.group.id && index === at.index) return null;
    return { tabId, fromGroupId: at.group.id, toGroupId: chipTarget.id, index };
  }
  const visible = groups.flatMap((group) => (group.collapsed ? [] : group.tabs.map((tab) => ({ id: tab.id, groupId: group.id }))));
  const from = visible.findIndex((entry) => entry.id === tabId);
  const to = visible.findIndex((entry) => tabKey(entry.id) === overKey);
  if (from < 0 || to < 0 || from === to) return null;
  const moved = visible.filter((entry) => entry.id !== tabId);
  moved.splice(to, 0, visible[from]!);
  const toGroupId = visible[to]!.groupId;
  const index = moved.slice(0, to).filter((entry) => entry.groupId === toGroupId).length;
  if (toGroupId === at.group.id && index === at.index) return null;
  return { tabId, fromGroupId: at.group.id, toGroupId, index };
}

/** Applies a move to the groups (immutably): what an App container does in `onMove`. */
export function applyTabStripMove(groups: readonly TabStripGroup[], move: TabStripMove): TabStripGroup[] {
  const tab = locateTab(groups, move.tabId)?.tab;
  if (!tab) return [...groups];
  return groups.map((group) => {
    const tabs = group.tabs.filter((entry) => entry.id !== move.tabId);
    if (group.id === move.toGroupId) tabs.splice(Math.min(move.index, tabs.length), 0, tab);
    return tabs.length === group.tabs.length && group.id !== move.toGroupId ? group : { ...group, tabs };
  });
}
