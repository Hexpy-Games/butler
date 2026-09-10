import { Button } from "../../components/Button";
import styles from "./ActivityHeatmap.module.css";

export interface ActivityHeatmapDay {
  id: string;
  label: string;
  count: number | null;
  monthLabel?: string;
  countLabel?: string;
}

export interface ActivityHeatmapProps {
  days: ActivityHeatmapDay[];
  ariaLabel?: string;
  startWeekday?: number;
  weekdayLabels?: string[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  legend?: { title: string; labels: string[] };
}

export function ActivityHeatmap({ days, ariaLabel, startWeekday = 0, weekdayLabels,
  selectedId, onSelect, legend }: ActivityHeatmapProps) {
  const offset = Math.max(0, Math.min(6, startWeekday));
  const weeks = Math.ceil((offset + days.length) / 7);
  const months: Array<{ label: string; start: number; span: number }> = [];
  for (let week = 0; week < weeks; week++) {
    const label = days[Math.max(0, week * 7 - offset)]?.monthLabel ?? "";
    const previous = months.at(-1);
    if (previous?.label === label) previous.span++;
    else months.push({ label, start: week + 1, span: 1 });
  }
  return <div className={styles.root} aria-label={ariaLabel}>
  <div className={styles.viewport}>
    <div className={styles.calendar}>
    {days.some((day) => day.monthLabel) && <>
      {weekdayLabels && <span />}
      <div className={styles.months} style={{ gridTemplateColumns: `repeat(${weeks}, 24px)` }} aria-hidden="true">
        {months.map((month) => <span key={month.start} style={{ gridColumn: `${month.start} / span ${month.span}` }}>{month.label}</span>)}
      </div>
    </>}
    {weekdayLabels && <div className={styles.weekdays} aria-hidden="true">
      {weekdayLabels.map((label, index) => <span key={index}>{label}</span>)}
    </div>}
    <div className={styles.heatmap}>
      {Array.from({ length: offset }, (_, index) =>
        <span key={`padding-${index}`} aria-hidden="true" data-padding />)}
      {days.map((day) => {
        const level = day.count === null ? "unknown" : day.count <= 0 ? 0
          : day.count === 1 ? 1 : day.count < 5 ? 2 : day.count < 10 ? 3 : 4;
        const label = day.count === null ? day.label : `${day.label}: ${day.countLabel ?? day.count}`;
        return onSelect ? <Button key={day.id} variant="borderless" className={styles.day}
          aria-label={label} title={label} data-level={level} aria-pressed={selectedId === day.id}
          onClick={() => onSelect(day.id)} />
          : <span key={day.id} className={styles.day} data-level={level} aria-label={label} title={label} />;
      })}
    </div>
    </div>
  </div>
  {legend && <div className={styles.legend}>
    <span className={styles.legendTitle}>{legend.title}</span>
    <div className={styles.legendItems}>
      {legend.labels.map((label, index) => <span className={styles.legendItem} key={label}>
        <span className={styles.day} data-level={index === 5 ? "unknown" : index} aria-hidden="true" />{label}
      </span>)}
    </div>
  </div>}
  </div>;
}
