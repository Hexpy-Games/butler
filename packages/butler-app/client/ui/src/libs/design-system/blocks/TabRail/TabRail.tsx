import { useEffect, useState } from "react";
import { PillButton } from "../../components/PillButton";
import { TintedGlass } from "../../components/TintedGlass";
import { Tooltip } from "../../components/Tooltip";
import { dsClass } from "../../lib/internal";
import { motionDuration } from "../../lib/motion";
import { SiteIcon } from "../../lib/SiteIcon";
import { useReducedMotion } from "../../lib/useReducedMotion";
import { useConversationRailReport } from "../ConversationShell/conversationRail";
import { LiveTabCard, type LiveTabCardProps } from "../LiveTabCard/LiveTabCard";
import { ScrollArea } from "../ScrollArea";
import { splitRailTabs, tabRailCap, tabRailMode, TAB_RAIL_MAX, type TabRailMode } from "./tabRailLayout";
import { useLayerBox } from "./useLayerBox";
import { useTabRailPresence, type TabRailPhase } from "./useTabRailPresence";
import styles from "./TabRail.module.css";

export interface TabRailTab extends Omit<LiveTabCardProps, "variant" | "closeLabel"> {
  id: string;
}

export interface TabRailLabels {
  /** The region's name: 버틀러의 탭 / Butler's tabs. */
  region: string;
  /** The ×: 탭 닫기 / Close tab. */
  close: string;
  /** The "+N" pill's name: 탭 2개 더 · 브라우저에서 보기. */
  more: (count: number) => string;
}

export interface TabRailProps {
  /** Butler's tabs in the owner's order (needs you, busy, error, idle; newest action first). */
  tabs: readonly TabRailTab[];
  labels: TabRailLabels;
  /** "+N": open the browser area on the first hidden tab. */
  onMore?: (firstHiddenId: string) => void;
  /** `auto` (default) picks full, compact or shelf from the container's width. */
  mode?: TabRailMode | "auto";
  /** Cards before "+N" (default 3; one fewer under 600px of height). */
  max?: number;
  /** Tabs present when the view changes (another conversation) do not play their entrance. */
  view?: string;
  /** Forces reduced motion on or off; defaults to the OS setting and the DS reduced-motion scope. */
  reducedMotion?: boolean;
}

function RailItem({ tab, phase, mode, closeLabel, settle }: { tab: TabRailTab; phase: TabRailPhase; mode: TabRailMode; closeLabel: string; settle: (id: string) => void }) {
  useEffect(() => {
    if (phase !== "leave") return undefined;
    const timer = window.setTimeout(() => settle(tab.id), motionDuration("fast") * 2);
    return () => window.clearTimeout(timer);
  }, [phase, settle, tab.id]);
  const { id: _id, ...card } = tab;
  return (
    <div className={styles.item} data-phase={phase} onAnimationEnd={phase === "leave" ? () => settle(tab.id) : undefined}>
      <LiveTabCard {...card} variant={mode === "shelf" ? "chip" : mode} closeLabel={mode === "full" ? closeLabel : undefined} />
    </div>
  );
}

function MorePill({ hidden, labels, onMore, plain }: { hidden: readonly TabRailTab[]; labels: TabRailLabels; onMore?: (id: string) => void; plain: boolean }) {
  if (!hidden.length) return null;
  const label = labels.more(hidden.length);
  return (
    <span className={styles.more}>
      <Tooltip label={label}>
        <PillButton surface={plain ? "plain" : "glass"} aria-label={label} onClick={() => onMore?.(hidden[0]!.id)}
          icon={plain ? undefined : <span className={styles.stack}>{hidden.slice(0, 3).map((tab) => <SiteIcon key={tab.id} src={tab.favicon} />)}</span>}>
          {`+${hidden.length}`}
        </PillButton>
      </Tooltip>
    </span>
  );
}

/**
 * Live previews of Butler's tabs beside the conversation. It fills its
 * positioned parent (the ConversationShell `rail` slot) without taking
 * pointer input outside the cards, and picks its layout from that width:
 * a full rail of 208px cards, a compact rail of 128×80 thumbnails, or a
 * 46px shelf strip that scrolls sideways on overflow.
 */
export function TabRail({ tabs, labels, onMore, mode: forced = "auto", max = TAB_RAIL_MAX, view = "", reducedMotion }: TabRailProps) {
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const box = useLayerBox(layer);
  const systemReduced = useReducedMotion();
  const reduced = reducedMotion ?? systemReduced;
  const mode = forced !== "auto" ? forced : box ? tabRailMode(box.width) : null;
  const { shown, hidden } = splitRailTabs(tabs, tabRailCap(box?.height ?? Number.POSITIVE_INFINITY, max));
  const { items, settle } = useTabRailPresence(shown, view, reduced);
  useConversationRailReport(tabs.length > 0);
  const cards = mode ? items.map(({ tab, phase }) => (
    <RailItem key={tab.id} tab={tab} phase={phase} mode={mode} closeLabel={labels.close} settle={settle} />
  )) : null;
  return (
    <div ref={setLayer} className={styles.layer} data-slot="tab-rail" data-mode={mode ?? undefined} data-reduced={reduced ? "true" : undefined}>
      {mode && items.length ? (
        <section className={styles.rail} data-mode={mode} aria-label={labels.region}>
          {mode === "shelf" ? (
            <TintedGlass className={dsClass(styles.shelf)} radius="popover" padding="none">
              <ScrollArea className={dsClass(styles.shelfScroll)} contentClassName={dsClass(styles.shelfRow)} orientation="x">{cards}</ScrollArea>
              <MorePill hidden={hidden} labels={labels} onMore={onMore} plain />
            </TintedGlass>
          ) : (
            <>
              {cards}
              <MorePill hidden={hidden} labels={labels} onMore={onMore} plain={false} />
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
