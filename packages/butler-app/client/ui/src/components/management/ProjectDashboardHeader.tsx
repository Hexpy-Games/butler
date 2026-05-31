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
  return (
    <DashboardHeader
      title={dashboard?.project.display_name ?? project?.display_name ?? "Project"}
      description={`${sessionsCount} project chats`}
      action={project ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => onNewProjectChat(project.id)}
        >
          <MessageSquarePlus size={16} /> New chat
        </Button>
      ) : undefined}
    />
  );
}
