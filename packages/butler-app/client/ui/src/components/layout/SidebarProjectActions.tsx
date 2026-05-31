import {
  Archive,
  LayoutDashboard,
  MessageSquarePlus,
  PencilLine,
  Pin,
  Trash2,
  ButtonContainer,
  OverflowActionMenu,
  IconButton,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ProjectSummary } from "@/app/types.ts";

export type ProjectAction = "rename" | "pin" | "archive" | "delete";

interface SidebarProjectActionsProps {
  project: ProjectSummary;
}

export function SidebarProjectActions({ project }: SidebarProjectActionsProps) {
  const openNewProjectChat = useButlerStore(
    (state) => state.openNewProjectChat,
  );
  const openProjectDashboard = useButlerStore(
    (state) => state.openProjectDashboard,
  );
  const runProjectAction = useButlerStore((state) => state.runProjectAction);

  return (
    <ButtonContainer
      className="no-drag"
      size="icon-sm"
      onClick={(event) => event.stopPropagation()}
    >
      <IconButton
        label={appCopy.sidebar.projectDashboard}
        onClick={(event) => {
          event.stopPropagation();
          openProjectDashboard(project.id);
        }}
      >
        <LayoutDashboard size={14} />
      </IconButton>
      <IconButton
        label={appCopy.sidebar.newProjectChat}
        onClick={(event) => {
          event.stopPropagation();
          openNewProjectChat(project.id);
        }}
      >
        <MessageSquarePlus size={14} />
      </IconButton>
      <OverflowActionMenu
        label={appCopy.sidebar.projectMenu}
        items={[
          {
            icon: <PencilLine size={14} />,
            label: appCopy.sessionActions.rename,
            onSelect: () => runProjectAction(project, "rename"),
          },
          {
            icon: <Pin size={14} />,
            label: project.pinned ? appCopy.sidebar.unpin : appCopy.sidebar.pin,
            onSelect: () => runProjectAction(project, "pin"),
          },
          {
            icon: <Archive size={14} />,
            label: appCopy.sessionActions.archive,
            onSelect: () => runProjectAction(project, "archive"),
          },
          {
            icon: <Trash2 size={14} />,
            label: appCopy.sidebar.delete,
            onSelect: () => runProjectAction(project, "delete"),
            variant: "destructive" as const,
          },
        ]}
      />
    </ButtonContainer>
  );
}
