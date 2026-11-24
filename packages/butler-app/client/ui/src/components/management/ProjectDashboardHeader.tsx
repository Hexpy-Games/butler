import { useState } from "react";
import { useCanonOnlineAvailable } from "@/app/canonOnline.ts";
import { CanonOnlineDialog } from "../canon/CanonOnlineDialog.tsx";
import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { Globe2, ImageIcon, MessageSquarePlus, OverflowActionMenu } from "@/butler-ds";
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
  const [onlineOpen, setOnlineOpen] = useState(false);
  const onlineAvailable = useCanonOnlineAvailable();
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
              items={[
                { icon: <ImageIcon size="sm" />, label: appCopy.projectSignpost.wallpaper, onSelect: () => setWallpaperOpen(true) },
                ...(onlineAvailable ? [{ icon: <Globe2 size="sm" />, label: appCopy.canon.online.title, onSelect: () => setOnlineOpen(true) }] : []),
              ]}
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
      {project && onlineOpen && <CanonOnlineDialog key={project.id} projectId={project.id} open={onlineOpen} onOpenChange={setOnlineOpen} />}
    </>
  );
}
