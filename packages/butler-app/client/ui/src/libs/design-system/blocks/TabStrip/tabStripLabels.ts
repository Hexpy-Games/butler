import { locateTab, type TabStripGroup, type TabStripGroupState, type TabStripMove, type TabStripTab, type TabStripTabState } from "./tabStripModel";

export interface TabStripLabels {
  /** Accessible name of the whole strip. */
  tabs: string;
  myTabs: string;
  newTab: string;
  closeTab: string;
  untitled: string;
  loading: string;
  working: string;
  waiting: string;
  crashed: string;
  tabCount: (count: number) => string;
  moved: (title: string, group: string, position: number) => string;
}

/** English defaults; the App container passes localized labels. */
export const TAB_STRIP_LABELS: TabStripLabels = {
  tabs: "Tabs",
  myTabs: "My tabs",
  newTab: "New tab",
  closeTab: "Close tab",
  untitled: "Untitled",
  loading: "Loading",
  working: "Butler is working",
  waiting: "Waiting for approval",
  crashed: "Page stopped",
  tabCount: (count) => (count === 1 ? "1 tab" : `${count} tabs`),
  moved: (title, group, position) => `${title}: ${group}, position ${position}`,
};

export function groupLabel(group: TabStripGroup, labels: TabStripLabels): string {
  return group.label?.trim() || (group.kind === "mine" ? labels.myTabs : labels.untitled);
}

const stateLabel = (state: TabStripTabState | TabStripGroupState | undefined, labels: TabStripLabels) =>
  state ? labels[state] : null;

export function tabTitle(tab: TabStripTab, labels: TabStripLabels): string {
  return tab.title.trim() || labels.untitled;
}

export function tabAccessibleLabel(tab: TabStripTab, labels: TabStripLabels): string {
  return [tabTitle(tab, labels), stateLabel(tab.state, labels)].filter(Boolean).join(", ");
}

export function chipAccessibleLabel(group: TabStripGroup, labels: TabStripLabels): string {
  return [groupLabel(group, labels), labels.tabCount(group.tabs.length), stateLabel(group.state, labels)].filter(Boolean).join(", ");
}

/** Live-region text after a move: the tab, its new group and its 1-based position there. */
export function movedAnnouncement(groups: readonly TabStripGroup[], move: TabStripMove, labels: TabStripLabels): string {
  const tab = locateTab(groups, move.tabId)?.tab;
  const target = groups.find((group) => group.id === move.toGroupId);
  if (!tab || !target) return "";
  return labels.moved(tabTitle(tab, labels), groupLabel(target, labels), move.index + 1);
}
