import { Button } from "../../components/Button";
import styles from "./ActivityHeatmap.module.css";

export interface ActivityHeatmapDay {
  id: string;
  label: string;
  count: number | null;
}

export interface ActivityHeatmapProps {
  days: ActivityHeatmapDay[];
  ariaLabel?: string;
  startWeekday?: number;
  weekdayLabels?: string[];
  selectedId?: string;
  onSelect?: (id: string) => void;
}

export function ActivityHeatmap({ days, ariaLabel, startWeekday = 0, weekdayLabels,
  selectedId, onSelect }: ActivityHeatmapProps) {
  return <div className={styles.viewport} aria-label={ariaLabel}>
    {weekdayLabels && <div className={styles.weekdays} aria-hidden="true">
      {weekdayLabels.map((label, index) => <span key={index}>{index % 2 ? label : ""}</span>)}
    </div>}
    <div className={styles.heatmap}>
      {Array.from({ length: Math.max(0, Math.min(6, startWeekday)) }, (_, index) =>
        <span key={`padding-${index}`} aria-hidden="true" />)}
      {days.map((day) => {
        const level = day.count === null ? "unknown" : day.count <= 0 ? 0
          : day.count === 1 ? 1 : day.count < 5 ? 2 : day.count < 10 ? 3 : 4;
        const label = day.count === null ? day.label : `${day.label}: ${day.count}`;
        return onSelect ? <Button key={day.id} variant="borderless" className={styles.day}
          aria-label={label} title={label} data-level={level} aria-pressed={selectedId === day.id}
          onClick={() => onSelect(day.id)} />
          : <span key={day.id} className={styles.day} data-level={level} aria-label={label} title={label} />;
      })}
    </div>
  </div>;
}
