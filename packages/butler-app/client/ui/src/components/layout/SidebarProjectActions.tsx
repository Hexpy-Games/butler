import { useAppLocale } from "@/app/copy.ts";
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
  useAppLocale();
  const openNewProjectChat = useButlerStore(
    (state) => state.openNewProjectChat,
  );
  const openProjectDashboard = useButlerStore(
    (state) => state.openProjectDashboard,
  );
  const runProjectAction = useButlerStore((state) => state.runProjectAction);

  return (
    <ButtonContainer
      windowDrag="no-drag"
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
        <LayoutDashboard size="sm" />
      </IconButton>
      <IconButton
        label={appCopy.sidebar.newProjectChat}
        onClick={(event) => {
          event.stopPropagation();
          openNewProjectChat(project.id);
        }}
      >
        <MessageSquarePlus size="sm" />
      </IconButton>
      <OverflowActionMenu
        label={appCopy.sidebar.projectMenu}
        items={[
          {
            icon: <PencilLine size="sm" />,
            label: appCopy.sessionActions.rename,
            onSelect: () => runProjectAction(project, "rename"),
          },
          {
            icon: <Pin size="sm" />,
            label: project.pinned ? appCopy.sidebar.unpin : appCopy.sidebar.pin,
            onSelect: () => runProjectAction(project, "pin"),
          },
          {
            icon: <Archive size="sm" />,
            label: appCopy.sessionActions.archive,
            onSelect: () => runProjectAction(project, "archive"),
          },
          {
            icon: <Trash2 size="sm" />,
            label: appCopy.sidebar.delete,
            onSelect: () => runProjectAction(project, "delete"),
            variant: "destructive" as const,
          },
        ]}
      />
    </ButtonContainer>
  );
}
