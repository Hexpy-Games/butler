import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { SpaceActivity } from "./SpaceActivity";
import {
  Archive,
  Folder,
  LayoutDashboard,
  MessageSquarePlus,
  PencilLine,
  Pin,
  Trash2,
  OverflowActionMenu,
  ButtonContainer,
} from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { useComposerStore } from "../conversation/composerStore";
import { useOrganization } from "@/app/space/organization";
import { spaceActivity } from "@/app/space/activity";
import type { SpaceRowData } from "@/app/space/projection";
import styles from "./SpaceInteractions.module.css";

export function SpaceRowMenu({
  row,
  open,
  onOpenChange,
}: {
  row: SpaceRowData;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  useAppLocale();
  const app = useButlerStore;
  const mutate = useOrganization((s) => s.mutate);
  const setDialog = useOrganization((s) => s.setDialog);
  const activity = spaceActivity(row.session);
  const items = [
    ...(row.session ? [{
      icon: <MessageSquarePlus />,
      label: appCopy.space.reference,
      onSelect: () => useComposerStore.getState().insertSessionReference?.({ sessionId: row.node.entityId, titleSnapshot: row.title }),
    }] : []),
    ...(row.project
      ? [
          {
            icon: <LayoutDashboard />,
            label: appCopy.space.dashboard,
            onSelect: () =>
              app.getState().openProjectDashboard(row.node.entityId),
          },
          {
            icon: <MessageSquarePlus />,
            label: appCopy.space.newChat,
            onSelect: () =>
              app.getState().openNewProjectChat(row.node.entityId),
          },
          {
            icon: <Folder />,
            label: appCopy.space.subgroup,
            onSelect: () => setDialog({ kind: "create", parentKey: row.node.key }),
          },
        ]
      : []),
    {
      icon: <PencilLine />,
      label: appCopy.space.rename,
      onSelect: () => {
        if (row.session)
          void app.getState().runSessionAction(row.session, "rename");
        else if (row.project)
          void app.getState().runProjectAction(row.project, "rename");
        else
          setDialog({
            kind: "rename",
            groupId: row.node.entityId,
            title: row.title,
          });
      },
    },
    {
      icon: <Folder />,
      label: appCopy.space.moveMenu,
      onSelect: () => setDialog({ kind: "move", sourceKey: row.node.key }),
    },
    ...(row.node.kind === "group"
      ? [
          {
            icon: <Folder />,
            label: appCopy.space.subgroup,
            onSelect: () =>
              setDialog({ kind: "create", parentKey: row.node.key }),
          },
          {
            icon: <Trash2 />,
            label: appCopy.space.dissolve,
            onSelect: () => {
              void mutate({ action: "dissolve", groupId: row.node.entityId });
            },
          },
        ]
      : [
          {
            icon: <Pin />,
            label: row.pinned ? appCopy.space.unpin : appCopy.space.pin,
            onSelect: () => {
              void mutate({
                action: "pin",
                nodeKey: row.node.key,
                pinned: !row.pinned,
              });
            },
          },
          {
            icon: <Archive />,
            label: appCopy.space.archive,
            onSelect: () => {
              if (row.session)
                void app.getState().runSessionAction(row.session, "archive");
              else if (row.project)
                void app.getState().runProjectAction(row.project, "archive");
            },
          },
          ...(row.project
            ? [
                {
                  icon: <Trash2 />,
                  label: appCopy.space.deleteProject,
                  variant: "destructive" as const,
                  onSelect: () => {
                    void app
                      .getState()
                      .runProjectAction(row.project!, "delete");
                  },
                },
              ]
            : []),
        ]),
  ];
  return (
    <ButtonContainer
      size="icon-sm"
      wrap={false}
      className={styles.menuAction}
      data-has-status={activity || undefined}
      data-menu-open={open || undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <SpaceActivity session={row.session} />
      <OverflowActionMenu
        className={styles.menuButton}
        label={appCopy.space.rowMenu(row.title)}
        items={row.node.entityId === "general" ? items.slice(0, 1) : items}
        open={open}
        onOpenChange={onOpenChange}
      />
    </ButtonContainer>
  );
}
