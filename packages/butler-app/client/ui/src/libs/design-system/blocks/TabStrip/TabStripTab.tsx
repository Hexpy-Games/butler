import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState, type MouseEvent, type PointerEvent } from "react";
import { ButlerThinkingMark } from "../../components/ButlerThinkingMark";
import { Clickable } from "../../components/Clickable";
import { IconButton } from "../../components/IconButton";
import { AlertCircle, Globe2, X } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import { Typo } from "../../components/Typo";
import { useComposedRefs } from "../../lib/composeRefs";
import { dsClass } from "../../lib/internal";
import { motionDuration, prefersReducedMotion } from "../../lib/motion";
import type { TabStripScope } from "./TabStripGroup";
import { tabAccessibleLabel, tabTitle } from "./tabStripLabels";
import { tabKey, type TabStripTab } from "./tabStripModel";
import { TAB_STRIP_STOP } from "./useTabStripNavigation";
import styles from "./TabStrip.module.css";

/** Favicon slot: activity replaces the site icon; a missing or broken icon shows a globe. */
function TabFavicon({ tab }: { tab: TabStripTab }) {
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  let mark;
  if (tab.state === "loading") mark = <Spinner size={14} />;
  else if (tab.state === "working") mark = <ButlerThinkingMark size="sm" state="working" />;
  else if (tab.state === "crashed") mark = <AlertCircle size="md" />;
  else if (tab.faviconSrc && brokenSrc !== tab.faviconSrc) {
    mark = <img src={tab.faviconSrc} alt="" width={16} height={16} draggable={false} onError={() => setBrokenSrc(tab.faviconSrc ?? null)} />;
  } else mark = <Globe2 size="md" />;
  return <span className={styles.favicon} data-state={tab.state} aria-hidden="true">{mark}</span>;
}

const stopPointer = (event: PointerEvent) => event.stopPropagation();

export function TabStripTabView({ tab, groupId, scope }: { tab: TabStripTab; groupId: string; scope: TabStripScope }) {
  const key = tabKey(tab.id);
  const item = { key, kind: "tab" as const, groupId, tabId: tab.id };
  const active = tab.id === scope.activeTabId;
  const closable = tab.closable !== false;
  const sortable = useSortable({
    id: key,
    disabled: !scope.draggable,
    transition: prefersReducedMotion() ? null : { duration: motionDuration("base"), easing: "var(--motion-ease-standard)" },
  });
  const ref = useComposedRefs<HTMLDivElement>(sortable.setNodeRef, scope.nav.register(key));
  // Tabs slide sideways only; the strip never lets a tab leave its row.
  const transform = sortable.transform ? CSS.Translate.toString({ ...sortable.transform, y: 0 }) : undefined;
  const close = (event: MouseEvent) => {
    event.stopPropagation();
    scope.onClose(tab.id);
  };
  return (
    <div ref={ref} className={styles.slot} data-active={active || undefined} data-dragging={sortable.isDragging || undefined}
      data-test-class="tab-strip-tab" style={{ transform, transition: sortable.transition ?? undefined }}
      {...(scope.draggable ? sortable.listeners : undefined)}>
      <Clickable role="tab" stretch aria-selected={active} aria-controls={scope.panelId} aria-label={tabAccessibleLabel(tab, scope.labels)}
        tabIndex={scope.nav.rovingKey === key ? 0 : -1} {...{ [TAB_STRIP_STOP]: "" }}
        className={dsClass(styles.tab)} data-entering={scope.entering.has(key) || undefined} data-state={tab.state}
        onClick={() => scope.onActivate(tab.id)} onKeyDown={scope.nav.onKeyDown(item)} onFocus={() => scope.nav.onFocusItem(key)}
        onMouseDown={(event) => event.button === 1 && event.preventDefault()}
        onAuxClick={(event) => { if (event.button === 1 && closable) close(event); }}>
        <TabFavicon tab={tab} />
        <Typo.Text className={dsClass(styles.title)} truncate>{tabTitle(tab, scope.labels)}</Typo.Text>
        {closable ? (
          <IconButton className={dsClass(styles.close)} label={scope.labels.closeTab} tabIndex={-1} onPointerDown={stopPointer} onClick={close}>
            <X size="sm" />
          </IconButton>
        ) : null}
      </Clickable>
    </div>
  );
}
