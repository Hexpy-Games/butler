import { Activity } from "@/butler-ds";
import { EmptyPanelLine } from "@/components/common/Display.tsx";
import { ActivityHeatmap, Section } from "@/butler-ds";
import type { ProjectDashboardActivityDay } from "@/app/types.ts";

export function ProjectActivityPanel({
  days,
}: {
  days: ProjectDashboardActivityDay[];
}) {
  return (
    <Section
      gap="lg"
      icon={<Activity size={16} />}
      title="Recent activity"
    >
      {days.length > 0 ? (
        <ActivityHeatmap
          ariaLabel="Recent 30 day project activity"
          days={days.map((day) => ({
            id: day.date,
            label: day.date,
            count: day.count,
          }))}
        />
      ) : (
        <EmptyPanelLine label="No recent activity yet" />
      )}
    </Section>
  );
}
