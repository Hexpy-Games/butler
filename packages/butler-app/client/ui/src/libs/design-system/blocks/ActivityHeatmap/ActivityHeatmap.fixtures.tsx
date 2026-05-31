import { ActivityHeatmap } from "./ActivityHeatmap";

export function ActivityHeatmapFixture() {
  return (
    <ActivityHeatmap
      days={Array.from({ length: 30 }, (_, index) => ({
        id: `day-${index}`,
        label: `Day ${index + 1}`,
        count: (index * 7) % 18,
      }))}
    />
  );
}
