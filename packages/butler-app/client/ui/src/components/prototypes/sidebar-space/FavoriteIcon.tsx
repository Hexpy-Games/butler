import { IconButton, Sparkles } from "@/butler-ds";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import { ConversationIcon } from "./ConversationIcon";
import styles from "./SidebarInteractions.module.css";

export function FavoriteIcon({ id }: { id: string }) {
  const item = useMock((s) => s.items.find((row) => row.id === id)!);
  const pin = useMock((s) => s.pin);
  return (
    <span className={styles.iconSlot}>
      <IconButton
        className={styles.favorite}
        aria-pressed={Boolean(item.pinned)}
        label={`${item.title} ${item.pinned ? "즐겨찾기 해제" : "즐겨찾기 추가"}`}
        onClick={(event) => {
          event.stopPropagation();
          pin(id);
        }}
        onKeyDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        draggable={false}
      >
        <span className={styles.normalIcon}>
          <ConversationIcon id={id} />
        </span>
        <span className={styles.starIcon}>
          <Sparkles size={16} fill={item.pinned ? "currentColor" : "none"} />
        </span>
      </IconButton>
    </span>
  );
}
