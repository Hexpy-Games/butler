import { useState } from "react";
import { ActivityHeatmap } from "./ActivityHeatmap";

export function ActivityHeatmapFixture() {
  const [selected, setSelected] = useState<string>();
  return (
    <ActivityHeatmap
      startWeekday={2}
      weekdayLabels={["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]}
      selectedId={selected}
      onSelect={setSelected}
      legend={{ title: "Active items per day", labels: ["0", "1", "2–4", "5–9", "10+", "Unavailable"] }}
      days={Array.from({ length: 90 }, (_, index) => ({
        id: `day-${index}`,
        label: `Day ${index + 1}`,
        monthLabel: index < 30 ? "Jun" : index < 61 ? "Jul" : "Aug",
        count: index === 3 ? null : (index * 7) % 18,
      }))}
    />
  );
}
