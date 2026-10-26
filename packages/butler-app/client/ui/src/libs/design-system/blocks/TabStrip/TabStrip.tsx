import { closestCenter, DndContext } from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import { useCallback, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { IconButton } from "../../components/IconButton";
import { Plus } from "../../components/Icons";
import type { DsBaseProps } from "../../lib/dsProps";
import { useComposedRefs } from "../../lib/composeRefs";
import { dsClass } from "../../lib/internal";
import { useEnteringKeys } from "../../lib/useEnteringKeys";
import { cn } from "../../lib/utils";
import { TabStripGroupView, type TabStripScope } from "./TabStripGroup";
import { TAB_STRIP_LABELS, type TabStripLabels } from "./tabStripLabels";
import { showsChip, tabKey, type TabStripGroup, type TabStripMove } from "./tabStripModel";
import { TAB_STRIP_DND_ACCESSIBILITY, useTabStripDrag } from "./useTabStripDrag";
import { useTabStripFit } from "./useTabStripFit";
import { useTabStripNavigation } from "./useTabStripNavigation";
import { useTabStripScroller } from "./useTabStripScroller";
import styles from "./TabStrip.module.css";

export interface TabStripProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "children"> {
  /** "My tabs" plus one group per conversation, in strip order. */
  groups: TabStripGroup[];
  activeTabId: string | null;
  /** Click, Enter or Space on a tab. */
  onActivate: (tabId: string) => void;
  /** Close button, middle-click, or Delete/Backspace on the focused tab. */
  onClose: (tabId: string) => void;
  /** Drag or Cmd/Ctrl+Shift+arrow reorder, within and between groups. Omit to lock the order. */
  onMove?: (move: TabStripMove) => void;
  /** A click on a group's title folds or unfolds it. Omit to keep groups as they are. */
  onToggleGroup?: (groupId: string, collapsed: boolean) => void;
  /** Shows the trailing new-tab button (unless group pills carry their own, see `onNewTabInGroup`). */
  onNewTab?: () => void;
  /** Ends every group pill in its own new-tab button; while pills show, the trailing one goes away. */
  onNewTabInGroup?: (groupId: string) => void;
  /** Id of the page area the tabs control (the NativeViewSlot), for aria-controls. */
  panelId?: string;
  /** Localized copy; English by default. */
  labels?: Partial<TabStripLabels>;
  /** Drops the title when the strip shows a single group of any kind (a conversation pane names it in its title bar). */
  hideChip?: boolean;
  /** Controls after the new-tab button at the row end (bring in a tab); kept out of the tab focus order. */
  trailing?: ReactNode;
}

/**
 * Browser tab strip: closable pill tabs that shrink to fit and scroll sideways when they no longer fit,
 * grouped as "my tabs" plus one muted, foldable outline pill per conversation. Pure presenter.
 */
export function TabStrip({
  groups, activeTabId, onActivate, onClose, onMove, onToggleGroup, onNewTab, onNewTabInGroup, panelId,
  labels: labelOverrides, hideChip = false, trailing, className, ...props
}: TabStripProps) {
  const labels = useMemo(() => ({ ...TAB_STRIP_LABELS, ...labelOverrides }), [labelOverrides]);
  const [announcement, setAnnouncement] = useState("");
  const pills = groups.filter((group) => showsChip(group, groups, hideChip)).map((group) => group.id).join("\n");
  const groupNewTab = Boolean(pills && onNewTabInGroup);
  const nav = useTabStripNavigation({ groups, activeTabId, labels, onClose, onMove, announce: setAnnouncement, hideChip, groupNewTab });
  const drag = useTabStripDrag({ groups, labels, onMove, announce: setAnnouncement });
  const tabKeys = useMemo(() => nav.items.flatMap((item) => (item.kind === "tab" ? [item.key] : [])), [nav.items]);
  const entering = useEnteringKeys(tabKeys, "tab-strip");
  const activeKey = activeTabId ? tabKey(activeTabId) : null;
  const activeNode = useCallback(() => (activeKey ? nav.node(activeKey) : null), [activeKey, nav.node]);
  const scroller = useTabStripScroller(activeNode, activeKey);
  const rootNode = useRef<HTMLDivElement | null>(null);
  const scrollerNode = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useComposedRefs<HTMLDivElement>(scroller.ref, scrollerNode);
  useTabStripFit(rootNode, scrollerNode, pills);
  const scope: TabStripScope = {
    groups, activeTabId, panelId, labels, hideChip, nav, entering, draggable: Boolean(onMove), onActivate, onClose, onMove, onToggleGroup,
    onNewTabInGroup: groupNewTab ? onNewTabInGroup : undefined,
  };

  return (
    <div ref={rootNode} role="group" aria-label={labels.tabs} className={cn(styles.root, className)} data-slot="tab-strip" onBlur={nav.onBlur} {...props}>
      <DndContext sensors={drag.sensors} collisionDetection={closestCenter} accessibility={TAB_STRIP_DND_ACCESSIBILITY} {...drag.handlers}>
        <SortableContext items={tabKeys} strategy={horizontalListSortingStrategy}>
          <div ref={scrollerRef} className={styles.scroller} data-grouped={pills ? "" : undefined}
            data-dragging={drag.draggingKey ? "true" : undefined} onWheel={scroller.onWheel}>
            {groups.map((group) => <TabStripGroupView key={group.id} group={group} scope={scope} />)}
          </div>
        </SortableContext>
      </DndContext>
      {onNewTab && !groupNewTab ? (
        <IconButton className={dsClass(styles.newTab)} label={labels.newTab} onClick={onNewTab}>
          <Plus size="md" />
        </IconButton>
      ) : null}
      {trailing ? <div className={styles.trailing} data-slot="tab-strip-trailing">{trailing}</div> : null}
      <span className="sr-only" aria-live="polite">{announcement}</span>
    </div>
  );
}
