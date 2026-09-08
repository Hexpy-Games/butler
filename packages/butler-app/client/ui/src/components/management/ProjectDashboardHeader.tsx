import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { MessageSquarePlus } from "@/butler-ds";
import { Button } from "@/butler-ds";
import { DashboardHeader } from "@/butler-ds";
import type {
  ProjectDashboardView as ProjectDashboardData,
  ProjectSummary,
} from "@/app/types.ts";

export function ProjectDashboardHeader({
  dashboard,
  project,
  sessionsCount,
  onNewProjectChat,
}: {
  dashboard: ProjectDashboardData | null;
  project?: ProjectSummary;
  sessionsCount: number;
  onNewProjectChat: (projectId: string) => void;
}) {
  useAppLocale();
  return (
    <DashboardHeader
      title={dashboard?.project.display_name ?? project?.display_name ?? appCopy.briefing.projectMoment}
      description={`${sessionsCount} project chats`}
      action={project ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => onNewProjectChat(project.id)}
        >
          <MessageSquarePlus size={16} /> {appCopy.interfaceFeedback.newChat}</Button>
      ) : undefined}
    />
  );
}
