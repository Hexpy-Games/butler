import {
  Archive,
  ButtonContainer,
  LayoutDashboard,
  MessageSquarePlus,
  PencilLine,
  Pin,
  Trash2,
  OverflowActionMenu,
  Paperclip,
  Folder,
} from "@/butler-ds";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import styles from "./SidebarInteractions.module.css";
import { SpaceSessionStatus } from "./SpaceSessionStatus";

export function SpaceItemMenu({
  id,
  open,
  onOpenChange,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const item = useMock((s) => s.items.find((row) => row.id === id)!);
  const setDialog = useMock((s) => s.setDialog);
  const pin = useMock((s) => s.pin);
  const attach = useMock((s) => s.attach);
  const openItem = useMock((s) => s.open);
  const newChat = useMock((s) => s.newProjectChat);
  const remove = useMock((s) => s.removeItem);
  const isProject = item.kind === "project";
  const isSession = item.kind === "session";
  const items = [
    ...(isProject
      ? [
          {
            icon: <LayoutDashboard />,
            label: "프로젝트 대시보드",
            onSelect: () => openItem(id),
          },
          {
            icon: <MessageSquarePlus />,
            label: "새 대화",
            onSelect: () => newChat(id),
          },
        ]
      : []),
    {
      icon: <PencilLine />,
      label: "이름 변경",
      onSelect: () => setDialog({ type: "rename", id }),
    },
    ...(isSession
      ? [
          {
            icon: <Paperclip />,
            label: "현재 대화에 참조하기",
            onSelect: () => attach(id),
          },
          {
            icon: <Folder />,
            label: "이동…",
            onSelect: () => setDialog({ type: "move", id }),
          },
        ]
      : []),
    ...(item.kind !== "group"
      ? [
          {
            icon: <Pin />,
            label: item.pinned ? "즐겨찾기 해제" : "즐겨찾기에 추가",
            onSelect: () => pin(id),
          },
          {
            icon: <Archive />,
            label: "보관",
            onSelect: () => remove(id, "archive"),
          },
        ]
      : []),
    ...(isProject
      ? [
          {
            icon: <Trash2 />,
            label: "프로젝트 삭제",
            variant: "destructive" as const,
            onSelect: () => setDialog({ type: "delete-project", id }),
          },
        ]
      : []),
  ];
  return (
    <ButtonContainer
      size="icon-sm"
      className={styles.menuAction}
      data-has-status={Boolean(item.activity) || undefined}
      data-menu-open={open || undefined}
      wrap={false}
      onClick={(event) => event.stopPropagation()}
    >
      {item.activity && (
        <span className={styles.menuStatus}>
          <SpaceSessionStatus id={id} />
        </span>
      )}
      <OverflowActionMenu
        className={styles.menuButton}
        label={`${item.title} 메뉴`}
        items={items}
        open={open}
        onOpenChange={onOpenChange}
      />
    </ButtonContainer>
  );
}
