import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { Activity } from "@/butler-ds";
import { EmptyPanelLine } from "@/components/common/Display.tsx";
import { ActivityHeatmap, Section } from "@/butler-ds";
import type { ProjectDashboardActivityDay } from "@/app/types.ts";

export function ProjectActivityPanel({
  days,
}: {
  days: ProjectDashboardActivityDay[];
}) {
  useAppLocale();
  return (
    <Section
      gap="lg"
      icon={<Activity size={16} />}
      title={appCopy.interfacePanels.recentActivity}
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
        <EmptyPanelLine label={appCopy.interfacePanels.noRecentActivity} />
      )}
    </Section>
  );
}
