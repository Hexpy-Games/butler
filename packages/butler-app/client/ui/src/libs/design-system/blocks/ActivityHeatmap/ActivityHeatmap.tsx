import { memo, useCallback, type CSSProperties } from "react";
import { Button } from "../../components/Button";
import { Tooltip } from "../../components/Tooltip";
import { useScrollEdges } from "../../lib/useScrollEdges";
import styles from "./ActivityHeatmap.module.css";
import { useAnchoredScroll, useCellFocus } from "./useHeatmapFocus";
import { useFitCell } from "./useFitCell";
import { dsClass, dsStyle } from "../../lib/internal";

export type ActivityHeatmapLevel = 0 | 1 | 2 | 3 | 4;

export interface ActivityHeatmapDay {
  id: string;
  label: string;
  count: number | null;
  monthLabel?: string;
  countLabel?: string;
  /** Shade computed by the screen; replaces the built-in count bands when set. */
  level?: ActivityHeatmapLevel;
}

export interface ActivityHeatmapProps {
  days: ActivityHeatmapDay[];
  ariaLabel?: string;
  startWeekday?: number;
  weekdayLabels?: string[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  legend?: { title?: string; labels: string[] };
  /** `default` keeps 24px targets; `compact` draws 10px cells for a year at a glance. */
  cell?: "default" | "compact";
  /** `end` opens scrolled to the latest week. */
  scrollAnchor?: "start" | "end";
}

/** Months shorter than this many visible weeks keep their columns but drop the name. */
const MIN_MONTH_WEEKS = 3;

function dayLevel(day: ActivityHeatmapDay): ActivityHeatmapLevel | "unknown" {
  if (day.count === null) return "unknown";
  if (day.level !== undefined) return day.level;
  return day.count <= 0 ? 0 : day.count === 1 ? 1 : day.count < 5 ? 2 : day.count < 10 ? 3 : 4;
}

function dayLabel(day: ActivityHeatmapDay): string {
  return day.count === null ? day.label : `${day.label} · ${day.countLabel ?? day.count}`;
}

function monthSpans(days: ActivityHeatmapDay[], offset: number, weeks: number) {
  const months: Array<{ label: string; start: number; span: number }> = [];
  for (let week = 0; week < weeks; week++) {
    const label = days[Math.max(0, week * 7 - offset)]?.monthLabel ?? "";
    const previous = months.at(-1);
    if (previous?.label === label) previous.span++;
    else months.push({ label, start: week + 1, span: 1 });
  }
  return months;
}

interface CellProps {
  day: ActivityHeatmapDay;
  index: number;
  position: number;
  tabbable: boolean;
  selected: boolean;
  onSelect?: (id: string) => void;
}

/** One day. Its column and row drive the staggered shade transition. */
const HeatmapCell = memo(function HeatmapCell({ day, index, position, tabbable, selected, onSelect }: CellProps) {
  const style = dsStyle({ "--heatmap-column": Math.floor(position / 7), "--heatmap-row": position % 7 } as CSSProperties);
  const common = {
    "aria-label": dayLabel(day),
    "data-level": dayLevel(day),
    "data-index": index,
    tabIndex: tabbable ? 0 : -1,
    style,
  };
  return onSelect
    ? <Button {...common} variant="borderless" className={dsClass(styles.day)} aria-pressed={selected} onClick={() => onSelect(day.id)} />
    : <span {...common} role="img" className={styles.day} />;
});

function Weekdays({ labels, months }: { labels: string[]; months: boolean }) {
  return <div className={styles.weekdays} aria-hidden="true">
    {months && <span className={styles.monthSpacer} />}
    {labels.map((label, index) => <span key={index}>{label}</span>)}
  </div>;
}

export function ActivityHeatmap({ days, ariaLabel, startWeekday = 0, weekdayLabels,
  selectedId, onSelect, legend, cell = "default", scrollAnchor = "start" }: ActivityHeatmapProps) {
  const offset = Math.max(0, Math.min(6, startWeekday));
  const weeks = Math.ceil((offset + days.length) / 7);
  const months = monthSpans(days, offset, weeks);
  const hasMonths = days.some((day) => day.monthLabel);
  const fadeRef = useScrollEdges("x");
  const viewportRef = useAnchoredScroll(scrollAnchor, weeks);
  const [fitCell, fitRef] = useFitCell(weeks);
  const setViewport = useCallback((node: HTMLDivElement | null) => { fadeRef(node); fitRef(node); viewportRef.current = node; }, [fadeRef, fitRef, viewportRef]);
  const selectedIndex = days.findIndex((day) => day.id === selectedId);
  const focus = useCellFocus(days, selectedIndex >= 0 ? selectedIndex : scrollAnchor === "end" ? days.length - 1 : 0);
  const activeDay = focus.active === null ? undefined : days[focus.active];
  const activePosition = (focus.active ?? 0) + offset;
  const anchorStyle = { "--heatmap-column": Math.floor(activePosition / 7), "--heatmap-row": activePosition % 7 } as CSSProperties;
  const rootStyle = fitCell === null ? undefined : { "--heatmap-cell-fit": `${fitCell}px` } as CSSProperties;
  return <div className={styles.root} data-cell={cell} style={rootStyle} role="group" aria-label={ariaLabel}>
  <div className={styles.frame}>
    {weekdayLabels && <Weekdays labels={weekdayLabels} months={hasMonths} />}
    <div ref={setViewport} className={styles.viewport}>
      <div className={styles.calendar}>
        {hasMonths && <div className={styles.months} style={{ "--heatmap-weeks": weeks } as CSSProperties} aria-hidden="true">
          {months.map((month) => <span key={month.start} style={{ gridColumn: `${month.start} / span ${month.span}` }}>
            {month.span >= MIN_MONTH_WEEKS ? month.label : ""}</span>)}
        </div>}
        <div ref={focus.gridRef} className={styles.heatmap} onKeyDown={focus.onKeyDown} onPointerOver={focus.onPointerOver}
          onPointerLeave={focus.onPointerLeave} onFocus={focus.onFocus} onBlur={focus.onBlur}>
          {Array.from({ length: offset }, (_, index) => <span key={`padding-${index}`} aria-hidden="true" data-padding />)}
          {days.map((day, index) => <HeatmapCell key={day.id} day={day} index={index} position={index + offset}
            tabbable={index === focus.tabIndex} selected={selectedId === day.id} onSelect={onSelect} />)}
          <Tooltip label={activeDay ? dayLabel(activeDay) : undefined} open={Boolean(activeDay)}>
            <span className={styles.tooltipAnchor} style={anchorStyle} aria-hidden="true" />
          </Tooltip>
        </div>
      </div>
    </div>
  </div>
  {legend && <div className={styles.legend}>
    {legend.title && <span className={styles.legendTitle}>{legend.title}</span>}
    <div className={styles.legendItems}>
      {legend.labels.map((label, index) => <span className={styles.legendItem} key={label}>
        <span className={styles.day} data-level={index === 5 ? "unknown" : index} aria-hidden="true" />{label}
      </span>)}
    </div>
  </div>}
  </div>;
}
