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
        label="Active sessions"
        value={String(stats?.active_sessions ?? sessionsCount)}
      />
      <DashboardStat label="Specs" value={String(stats?.specs ?? 0)} />
      <DashboardStat label="Plans" value={String(stats?.plans ?? 0)} />
      <DashboardStat
        label="Archived"
        value={String(stats?.archived_sessions ?? 0)}
      />
    </MetricGrid>
  );
}
