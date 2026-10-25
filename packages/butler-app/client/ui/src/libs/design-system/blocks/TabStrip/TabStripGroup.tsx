import { useDroppable } from "@dnd-kit/core";
import { useLayoutEffect, useRef } from "react";
import { ButlerThinkingMark } from "../../components/ButlerThinkingMark";
import { Clickable } from "../../components/Clickable";
import { IconButton } from "../../components/IconButton";
import { AlertCircle, Plus, ShieldQuestion } from "../../components/Icons";
import { Tooltip } from "../../components/Tooltip";
import { Typo } from "../../components/Typo";
import { useComposedRefs } from "../../lib/composeRefs";
import { dsClass } from "../../lib/internal";
import { animateMotion } from "../../lib/motion";
import { chipAccessibleLabel, groupLabel, type TabStripLabels } from "./tabStripLabels";
import { chipKey, newTabKey, showsChip, type TabStripGroup, type TabStripGroupState, type TabStripMove } from "./tabStripModel";
import { TabFavicon, TabStripTabView } from "./TabStripTab";
import { TAB_STRIP_STOP, type TabStripNavigation } from "./useTabStripNavigation";
import styles from "./TabStrip.module.css";

/** What every group, chip and tab of one strip shares. */
export interface TabStripScope {
  groups: readonly TabStripGroup[];
  activeTabId: string | null;
  panelId?: string;
  labels: TabStripLabels;
  hideChip: boolean;
  nav: TabStripNavigation;
  entering: ReadonlySet<string>;
  draggable: boolean;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onMove?: (move: TabStripMove) => void;
  onToggleGroup?: (groupId: string, collapsed: boolean) => void;
  onNewTabInGroup?: (groupId: string) => void;
}

/** A folded group previews this many favicons, then counts the rest. */
const FOLDED_FAVICONS = 3;

function GroupStateMark({ state }: { state: TabStripGroupState }) {
  const mark = state === "working"
    ? <ButlerThinkingMark size="sm" state="working" />
    : state === "waiting" ? <ShieldQuestion size="sm" /> : <AlertCircle size="sm" />;
  return <span className={styles.stateMark} data-state={state} aria-hidden="true">{mark}</span>;
}

/** A folded group's first favicons and the count of the rest. */
function FoldedPreview({ group, labels }: { group: TabStripGroup; labels: TabStripLabels }) {
  const shown = group.tabs.slice(0, FOLDED_FAVICONS);
  const rest = group.tabs.length - shown.length;
  return (
    <span className={styles.folded} aria-hidden="true">
      {shown.map((tab) => <TabFavicon key={tab.id} tab={tab} />)}
      {rest > 0 ? <Typo.Caption numeric="tabular" tone="tertiary">{labels.moreTabs(rest)}</Typo.Caption> : null}
    </span>
  );
}

/** The group's title: folds and unfolds the group, takes dropped tabs, shows group state. */
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
      {group.collapsed && group.tabs.length > 0 ? <FoldedPreview group={group} labels={scope.labels} /> : null}
    </Clickable>
  );
  return (
    <div ref={ref} className={styles.chipSlot} data-test-class="tab-strip-chip">
      {/* The capped label truncates; the tooltip keeps the full name and the group state. */}
      <Tooltip label={[groupLabel(group, scope.labels), group.state ? scope.labels[group.state] : null].filter(Boolean).join(" · ")}>
        {chip}
      </Tooltip>
    </div>
  );
}

/** The group's own new-tab button at the end of its pill: a stop after its tabs. */
function GroupNewTab({ group, scope }: { group: TabStripGroup; scope: TabStripScope }) {
  const key = newTabKey(group.id);
  return (
    <div ref={scope.nav.register(key)} className={styles.groupNew}>
      <IconButton label={scope.labels.newTabIn(groupLabel(group, scope.labels))}
        tabIndex={scope.nav.rovingKey === key ? 0 : -1} {...{ [TAB_STRIP_STOP]: "" }}
        onKeyDown={scope.nav.onKeyDown({ key, kind: "new", groupId: group.id })} onFocus={() => scope.nav.onFocusItem(key)}
        onClick={() => scope.onNewTabInGroup?.(group.id)}>
        <Plus size="sm" />
      </IconButton>
    </div>
  );
}

/**
 * Slides a fold's width closed or open (to its content's width) when `collapsed` flips; a slide that
 * interrupts another starts from the live width. Opening caps max-width rather than setting width, so
 * tabs that narrow on the way (the strip refits them) never overshoot. Reduced motion: at once.
 */
function useFoldSlide(collapsed: boolean) {
  const fold = useRef<HTMLDivElement>(null);
  const previous = useRef(collapsed);
  const slide = useRef<Animation | null>(null);
  useLayoutEffect(() => () => slide.current?.cancel(), []);
  useLayoutEffect(() => {
    if (previous.current === collapsed) return;
    previous.current = collapsed;
    const node = fold.current;
    if (!node?.firstElementChild) return;
    const open = node.firstElementChild.getBoundingClientRect().width;
    const from = slide.current?.playState === "running" ? node.getBoundingClientRect().width : collapsed ? open : 0;
    const property = collapsed ? "width" : "maxWidth";
    slide.current?.cancel();
    slide.current = animateMotion(node, [{ [property]: `${from}px` }, { [property]: `${collapsed ? 0 : open}px` }],
      { duration: "base", easing: "standard" });
  }, [collapsed]);
  return fold;
}

/**
 * One group. Beside other groups it is an outline pill: its title (which folds it), its tabs and
 * its own new-tab button; folding slides the tabs and the button closed. A group shown without its
 * title is just its tabs.
 */
export function TabStripGroupView({ group, scope }: { group: TabStripGroup; scope: TabStripScope }) {
  const collapsed = Boolean(group.collapsed);
  const titled = showsChip(group, scope.groups, scope.hideChip);
  const fold = useFoldSlide(collapsed);
  const tabs = (
    <div role="tablist" aria-label={groupLabel(group, scope.labels)} aria-orientation="horizontal" className={styles.tabs}>
      {group.tabs.map((tab) => <TabStripTabView key={tab.id} tab={tab} groupId={group.id} folded={collapsed} scope={scope} />)}
    </div>
  );
  if (!titled) {
    return (
      // A lone group shown without its chip is the pane's own tabs: full strength, like "my tabs".
      <div className={styles.group} data-kind={scope.hideChip && scope.groups.length === 1 ? "mine" : group.kind} data-collapsed={collapsed || undefined}>
        {!collapsed && group.tabs.length > 0 ? tabs : null}
      </div>
    );
  }
  return (
    <div className={styles.group} data-titled="" data-kind={group.kind} data-collapsed={collapsed || undefined} data-test-class="tab-strip-group">
      <TabStripChip group={group} scope={scope} />
      {/* Folded tabs stay mounted (inert) so the fold can slide them closed. */}
      <div ref={fold} className={styles.fold} data-collapsed={collapsed || undefined} inert={collapsed || undefined}>
        <div className={styles.foldBody}>
          {group.tabs.length > 0 ? tabs : null}
          {scope.onNewTabInGroup ? <GroupNewTab group={group} scope={scope} /> : null}
        </div>
      </div>
    </div>
  );
}
