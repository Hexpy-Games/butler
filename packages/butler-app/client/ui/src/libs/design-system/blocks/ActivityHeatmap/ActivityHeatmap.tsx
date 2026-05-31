import type { CSSProperties } from "react";
import styles from "./ActivityHeatmap.module.css";

export interface ActivityHeatmapDay {
  id: string;
  label: string;
  count: number;
}

export interface ActivityHeatmapProps {
  days: ActivityHeatmapDay[];
  ariaLabel?: string;
}

export function ActivityHeatmap({
  days,
  ariaLabel = "Recent activity",
}: ActivityHeatmapProps) {
  const peak = Math.max(1, ...days.map((day) => day.count));

  return (
    <div className={styles.heatmap} aria-label={ariaLabel}>
      {days.map((day) => (
        <span
          aria-label={`${day.label}: ${day.count}`}
          className={styles.day}
          key={day.id}
          style={
            {
              "--activity-strength": `${Math.round(16 + (day.count / peak) * 54)}%`,
            } as CSSProperties
          }
          title={`${day.label}: ${day.count}`}
        />
      ))}
    </div>
  );
}
