import { Folder, LayoutDashboard, MessageSquare, Notebook } from "@/butler-ds";
import styles from "./SidebarInteractions.module.css";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import { isProjectConversation } from "@/app/prototypes/sidebar-space/sample-data";

export function ConversationIcon({ id }: { id: string }) {
  const kind = useMock((s) => s.items.find((row) => row.id === id)?.kind);
  const project = useMock((s) => {
    const item = s.items.find((row) => row.id === id);
    return item ? isProjectConversation(item, s.items) : false;
  });
  const Glyph =
    kind === "group"
      ? Folder
      : kind === "project"
        ? LayoutDashboard
        : project
          ? Notebook
          : MessageSquare;
  const label =
    kind === "group"
      ? "그룹"
      : kind === "project"
        ? "프로젝트"
        : project
          ? "프로젝트 대화"
          : "일반 대화";
  return (
    <span className={styles.identityIcon}>
      <Glyph size={16} aria-label={label} />
    </span>
  );
}
