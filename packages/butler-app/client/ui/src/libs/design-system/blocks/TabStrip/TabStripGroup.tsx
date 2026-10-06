import { useDroppable } from "@dnd-kit/core";
import { ButlerThinkingMark } from "../../components/ButlerThinkingMark";
import { Clickable } from "../../components/Clickable";
import { AlertCircle, ChevronDown, ShieldQuestion } from "../../components/Icons";
import { Tooltip } from "../../components/Tooltip";
import { Typo } from "../../components/Typo";
import { useComposedRefs } from "../../lib/composeRefs";
import { dsClass } from "../../lib/internal";
import { chipAccessibleLabel, groupLabel, type TabStripLabels } from "./tabStripLabels";
import { chipKey, showsChip, type TabStripGroup, type TabStripGroupState, type TabStripMove } from "./tabStripModel";
import { TabStripTabView } from "./TabStripTab";
import { TAB_STRIP_STOP, type TabStripNavigation } from "./useTabStripNavigation";
import styles from "./TabStrip.module.css";

/** What every group, chip and tab of one strip shares. */
export interface TabStripScope {
  groups: readonly TabStripGroup[];
  activeTabId: string | null;
  panelId?: string;
  labels: TabStripLabels;
  nav: TabStripNavigation;
  entering: ReadonlySet<string>;
  draggable: boolean;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onMove?: (move: TabStripMove) => void;
  onToggleGroup?: (groupId: string, collapsed: boolean) => void;
}

function GroupStateMark({ state }: { state: TabStripGroupState }) {
  const mark = state === "working"
    ? <ButlerThinkingMark size="sm" state="working" />
    : state === "waiting" ? <ShieldQuestion size="sm" /> : <AlertCircle size="sm" />;
  return <span className={styles.stateMark} data-state={state} aria-hidden="true">{mark}</span>;
}

/** The group's labelled chip: folds and unfolds the group, takes dropped tabs, shows group state. */
function TabStripChip({ group, scope }: { group: TabStripGroup; scope: TabStripScope }) {
  const key = chipKey(group.id);
  const drop = useDroppable({ id: key, disabled: !scope.draggable });
  const ref = useComposedRefs<HTMLDivElement>(drop.setNodeRef, scope.nav.register(key));
  const activeWithin = Boolean(group.collapsed && group.tabs.some((tab) => tab.id === scope.activeTabId));
  const chip = (
    <Clickable aria-expanded={!group.collapsed} aria-label={chipAccessibleLabel(group, scope.labels)}
      tabIndex={scope.nav.rovingKey === key ? 0 : -1} {...{ [TAB_STRIP_STOP]: "" }}
      className={dsClass(styles.chip)} data-kind={group.kind} data-state={group.state}
      data-over={drop.isOver || undefined} data-active-within={activeWithin || undefined}
      disabled={!scope.onToggleGroup} onClick={() => scope.onToggleGroup?.(group.id, !group.collapsed)}
      onKeyDown={scope.nav.onKeyDown({ key, kind: "chip", groupId: group.id })} onFocus={() => scope.nav.onFocusItem(key)}>
      {group.state ? <GroupStateMark state={group.state} /> : null}
      <Typo.Text className={dsClass(styles.chipLabel)} truncate>{groupLabel(group, scope.labels)}</Typo.Text>
      {group.collapsed ? <Typo.Text numeric="tabular" tone="tertiary" aria-hidden="true">{group.tabs.length}</Typo.Text> : null}
      <ChevronDown size="sm" className={dsClass(styles.chevron)} aria-hidden="true" />
    </Clickable>
  );
  return (
    <div ref={ref} className={styles.chipSlot} data-test-class="tab-strip-chip">
      {group.state ? <Tooltip label={scope.labels[group.state]}>{chip}</Tooltip> : chip}
    </div>
  );
}

/** One group: its chip, then (unless folded) its tabs as a labelled tablist. */
export function TabStripGroupView({ group, scope }: { group: TabStripGroup; scope: TabStripScope }) {
  const open = !group.collapsed && group.tabs.length > 0;
  return (
    <div className={styles.group} data-kind={group.kind} data-collapsed={group.collapsed || undefined}>
      {showsChip(group, scope.groups) ? <TabStripChip group={group} scope={scope} /> : null}
      {open ? (
        <div role="tablist" aria-label={groupLabel(group, scope.labels)} aria-orientation="horizontal" className={styles.tabs}>
          {group.tabs.map((tab) => <TabStripTabView key={tab.id} tab={tab} groupId={group.id} scope={scope} />)}
        </div>
      ) : null}
    </div>
  );
}
