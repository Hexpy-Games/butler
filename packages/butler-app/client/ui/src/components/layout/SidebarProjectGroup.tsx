import { Button, Folder, FolderOpen, CollapsibleNavGroup } from "@/butler-ds";
import { SidebarProjectActions } from "@/components/layout/SidebarProjectActions.tsx";
import { SidebarProjectSessionItem } from "@/components/layout/SidebarProjectSessionItem.tsx";
import { useSidebarSessionPaging } from "@/components/layout/useSidebarSessionPaging.ts";
import { useButlerStore } from "@/app/store.ts";
import { appCopy } from "@/app/copy.ts";
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
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const paging = useSidebarSessionPaging(sessions, activeChatId);
  const effectiveCollapsed = collapsed || projectRowCollapsed;

  return (
    <CollapsibleNavGroup
      icon={effectiveCollapsed ? <Folder /> : <FolderOpen />}
      label={project.display_name}
      expanded={!effectiveCollapsed}
      onToggle={onToggleCollapse}
      actions={<SidebarProjectActions project={project} />}
      dataTestClass="project-group-row"
      contentDataTestClass="project-session-list"
    >
      {paging.visibleSessions.map((session) => (
        <SidebarProjectSessionItem
          key={session.id}
          session={session}
        />
      ))}
      {paging.remainingCount > 0 ? (
        <Button
          data-test-class="sidebar-load-more"
          onClick={paging.showMore}
          size="sm"
          stretch
          text={`${appCopy.common.more} (${paging.remainingCount})`}
          type="button"
          variant="ghost"
        />
      ) : null}
    </CollapsibleNavGroup>
  );
}
