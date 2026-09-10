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
      days={Array.from({ length: 90 }, (_, index) => ({
        id: `day-${index}`,
        label: `Day ${index + 1}`,
        count: index === 3 ? null : (index * 7) % 18,
      }))}
    />
  );
}
