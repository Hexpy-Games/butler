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
  const app = useButlerStore;
  const mutate = useOrganization((s) => s.mutate);
  const setDialog = useOrganization((s) => s.setDialog);
  const activity = spaceActivity(row.session);
  const items = [
    ...(row.session ? [{
      icon: <MessageSquarePlus />,
      label: "작성 중인 메시지에 참조",
      onSelect: () => useComposerStore.getState().insertSessionReference?.({ sessionId: row.node.entityId, titleSnapshot: row.title }),
    }] : []),
    ...(row.project
      ? [
          {
            icon: <LayoutDashboard />,
            label: "프로젝트 대시보드",
            onSelect: () =>
              app.getState().openProjectDashboard(row.node.entityId),
          },
          {
            icon: <MessageSquarePlus />,
            label: "새 대화",
            onSelect: () =>
              app.getState().openNewProjectChat(row.node.entityId),
          },
          {
            icon: <Folder />,
            label: "하위 그룹 만들기",
            onSelect: () => setDialog({ kind: "create", parentKey: row.node.key }),
          },
        ]
      : []),
    {
      icon: <PencilLine />,
      label: "이름 변경",
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
      label: "이동…",
      onSelect: () => setDialog({ kind: "move", sourceKey: row.node.key }),
    },
    ...(row.node.kind === "group"
      ? [
          {
            icon: <Folder />,
            label: "하위 그룹 만들기",
            onSelect: () =>
              setDialog({ kind: "create", parentKey: row.node.key }),
          },
          {
            icon: <Trash2 />,
            label: "그룹 해제",
            onSelect: () => {
              void mutate({ action: "dissolve", groupId: row.node.entityId });
            },
          },
        ]
      : [
          {
            icon: <Pin />,
            label: row.pinned ? "즐겨찾기 해제" : "즐겨찾기에 추가",
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
            label: "보관",
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
                  label: "프로젝트 삭제",
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
        label={`${row.title} 메뉴`}
        items={row.node.entityId === "general" ? items.slice(0, 1) : items}
        open={open}
        onOpenChange={onOpenChange}
      />
    </ButtonContainer>
  );
}
