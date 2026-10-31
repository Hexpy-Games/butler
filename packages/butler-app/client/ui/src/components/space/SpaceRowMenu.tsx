import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { GeneralChannelMenu } from "./GeneralChannelMenu";
import { SpaceActivity } from "./SpaceActivity";
import {
  Archive,
  Folder,
  LayoutDashboard,
  MessageSquarePlus,
  PencilLine,
  Pin,
  Trash2,
  NavRowSwap,
  OverflowActionMenu,
} from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { useComposerStore } from "../conversation/composerStore";
import { useOrganization } from "@/app/space/organization";
import type { SpaceRowData } from "@/app/space/projection";

export function SpaceRowMenu({
  row,
  running,
  quiet = false,
  nested = false,
  open,
  onOpenChange,
}: {
  row: SpaceRowData;
  running?: boolean;
  /** The row's status belongs elsewhere: nothing rests in the trailing slot. */
  quiet?: boolean;
  nested?: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  useAppLocale();
  const app = useButlerStore;
  const mutate = useOrganization((s) => s.mutate);
  const setDialog = useOrganization((s) => s.setDialog);
  // Projects and groups start a chat that is created inside them.
  const newChat = row.project
    ? () => app.getState().openNewProjectChat(row.node.entityId)
    : row.node.kind === "group" ? () => app.getState().openNewGroupChat(row.node.entityId) : undefined;
  const items = [
    ...(newChat ? [{ icon: <MessageSquarePlus />, label: appCopy.space.newChat, onSelect: newChat }] : []),
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
  // The activity status rests in the trailing slot; the row menu replaces it on hover or focus.
  return (
    <NavRowSwap rest={quiet ? null : <SpaceActivity session={row.session} running={running} nested={nested} />} open={open}>
      {row.node.entityId === "general" ? <GeneralChannelMenu row={row} open={open} onOpenChange={onOpenChange} /> : <OverflowActionMenu
        label={appCopy.space.rowMenu(row.title)}
        items={items}
        open={open}
        onOpenChange={onOpenChange}
      />}
    </NavRowSwap>
  );
}
