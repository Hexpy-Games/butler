import { Folder, FolderOpen, CollapsibleNavGroup } from "@/butler-ds";
import { SidebarProjectActions } from "@/components/layout/SidebarProjectActions.tsx";
import { GitWorkspaceIndicator } from "@/components/layout/GitWorkspaceIndicator.tsx";
import { SidebarProjectSessionItem } from "@/components/layout/SidebarProjectSessionItem.tsx";
import type { ProjectSummary } from "@/app/types.ts";

interface SidebarProjectGroupProps {
  project: ProjectSummary;
  collapsed: boolean;
  projectRowCollapsed: boolean;
  onToggleCollapse: () => void;
}

export function SidebarProjectGroup({
  project,
  collapsed,
  projectRowCollapsed,
  onToggleCollapse,
}: SidebarProjectGroupProps) {
  const sessions = project.sessions ?? [];
  const effectiveCollapsed = collapsed || projectRowCollapsed;

  return (
    <CollapsibleNavGroup
      icon={effectiveCollapsed ? <Folder /> : <FolderOpen />}
      label={project.display_name}
      badge={<GitWorkspaceIndicator gitWorkspace={project.gitWorkspace} />}
      expanded={!effectiveCollapsed}
      onToggle={onToggleCollapse}
      actions={<SidebarProjectActions project={project} />}
      dataTestClass="project-group-row"
      contentDataTestClass="project-session-list"
    >
      {sessions.map((session) => (
        <SidebarProjectSessionItem
          key={session.id}
          session={session}
        />
      ))}
    </CollapsibleNavGroup>
  );
}
