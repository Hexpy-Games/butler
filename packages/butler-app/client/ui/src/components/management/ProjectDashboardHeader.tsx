import { useState } from "react";
import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { ImageIcon, MessageSquarePlus, OverflowActionMenu } from "@/butler-ds";
import { Button, ButtonContainer } from "@/butler-ds";
import { DashboardHeader } from "@/butler-ds";
import type {
  ProjectDashboardView as ProjectDashboardData,
  ProjectSummary,
} from "@/app/types.ts";
import { ProjectWallpaperDialog } from "./ProjectWallpaperDialog.tsx";

export function ProjectDashboardHeader({
  dashboard,
  project,
  onNewProjectChat,
}: {
  dashboard: ProjectDashboardData | null;
  project?: ProjectSummary;
  sessionsCount: number;
  onNewProjectChat: (projectId: string) => void;
}) {
  useAppLocale();
  const [wallpaperOpen, setWallpaperOpen] = useState(false);
  return (
    <>
      <DashboardHeader
        title={dashboard?.project.display_name ?? project?.display_name ?? appCopy.briefing.projectMoment}
        action={project ? (
          <ButtonContainer size="default">
            <Button
              type="button"
              variant="outline"
              onClick={() => onNewProjectChat(project.id)}
            >
              <MessageSquarePlus size="md" /> {appCopy.space.newChat}</Button>
            <OverflowActionMenu
              label={appCopy.sidebar.projectMenu}
              items={[{ icon: <ImageIcon size="sm" />, label: appCopy.projectSignpost.wallpaper, onSelect: () => setWallpaperOpen(true) }]}
            />
          </ButtonContainer>
        ) : undefined}
      />
      {project && (
        <ProjectWallpaperDialog
          key={project.id}
          projectId={project.id}
          value={project.wallpaper ?? dashboard?.preferences?.wallpaper ?? "inherit"}
          revision={dashboard?.preferences?.revision}
          open={wallpaperOpen}
          onOpenChange={setWallpaperOpen}
        />
      )}
    </>
  );
}
