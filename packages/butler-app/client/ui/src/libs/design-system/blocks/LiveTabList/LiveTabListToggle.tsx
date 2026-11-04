import { useLayoutEffect, useRef, useState } from "react";
import { Clickable } from "../../components/Clickable";
import { Typo } from "../../components/Typo";
import { TabFavicon } from "../TabStrip/TabStripTab";
import type { LiveTabListProps } from "./LiveTabList";
import { fitFavicons } from "./fitFavicons";
import styles from "./LiveTabList.module.css";

type Props = Pick<LiveTabListProps, "tabs" | "expanded" | "labels"> & { onToggle: () => void };

/** Measurement uses the same favicon and caption typography as the visible row. */
export function LiveTabListToggle({ tabs, expanded, labels, onToggle }: Props) {
  const row = useRef<HTMLSpanElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(0);
  useLayoutEffect(() => {
    const node = row.current, measures = probe.current;
    if (!node || !measures || expanded) return;
    const fit = () => {
      const icon = measures.firstElementChild!.getBoundingClientRect().width;
      const widths = [0, ...Array.from(measures.querySelectorAll<HTMLElement>("[data-count]"), el => el.getBoundingClientRect().width)];
      setShown(fitFavicons(tabs.length, node.clientWidth, icon, parseFloat(getComputedStyle(node).columnGap), widths));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    observer.observe(measures);
    return () => observer.disconnect();
  }, [tabs.length, expanded, labels.overflow]);
  const favicon = (tab: Props["tabs"][number]) => <TabFavicon key={tab.id} tab={{ id: tab.id, title: tab.title, faviconSrc: tab.favicon }} />;
  const rest = tabs.length - shown;
  return <Clickable bleed="inline" stretch aria-expanded={expanded} aria-label={expanded ? labels.less : labels.more(tabs.length)}
    data-test-class="live-tab-list-toggle" onClick={onToggle}>
    {expanded ? <Typo.Caption tone="tertiary">{labels.less}</Typo.Caption> : <span ref={row} className={styles.row} aria-hidden="true">
      {tabs.slice(0, shown).map(favicon)}
      {rest > 0 ? <Typo.Caption numeric="tabular" tone="tertiary" wrap="nowrap" shrink={false} data-slot="live-tab-overflow">{labels.overflow(rest)}</Typo.Caption> : null}
      <span ref={probe} className={styles.probe}>
        {favicon(tabs[0])}
        {tabs.map((tab, i) => <Typo.Caption key={tab.id} numeric="tabular" tone="tertiary" wrap="nowrap" data-count={i + 1}>{labels.overflow(i + 1)}</Typo.Caption>)}
      </span>
    </span>}
  </Clickable>;
}
