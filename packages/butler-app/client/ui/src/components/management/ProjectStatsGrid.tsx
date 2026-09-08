import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { ProjectDashboardView as ProjectDashboardData } from "@/app/types.ts";
import { MetricGrid } from "@/butler-ds";
import { DashboardStat } from "./DashboardStat.tsx";

export function ProjectStatsGrid({
  dashboard,
  sessionsCount,
}: {
  dashboard: ProjectDashboardData | null;
  sessionsCount: number;
}) {
  useAppLocale();
  const stats = dashboard?.stats;
  return (
    <MetricGrid>
      <DashboardStat
        label="7d messages"
        value={String(stats?.recent_messages_7d ?? 0)}
      />
      <DashboardStat
        label="30d messages"
        value={String(stats?.recent_messages_30d ?? 0)}
      />
      <DashboardStat
        label={appCopy.interfacePanels.activeSessions}
        value={String(stats?.active_sessions ?? sessionsCount)}
      />
      <DashboardStat label={appCopy.interfacePanels.specs} value={String(stats?.specs ?? 0)} />
      <DashboardStat label={appCopy.interfacePanels.plans} value={String(stats?.plans ?? 0)} />
      <DashboardStat
        label={appCopy.interfacePanels.archived}
        value={String(stats?.archived_sessions ?? 0)}
      />
    </MetricGrid>
  );
}
