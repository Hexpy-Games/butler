import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import {
  Folder,
  LayoutDashboard,
  MessageSquare,
  Notebook,
  IconButton,
  Sparkles,
  GeneralChat,
} from "@/butler-ds";
import { useOrganization } from "@/app/space/organization";
import type { SpaceRowData } from "@/app/space/projection";
import styles from "./SpaceInteractions.module.css";

export function SpaceGlyph({ row }: { row: SpaceRowData }) {
  useAppLocale();
  const Glyph =
    row.node.entityId === "general"
      ? GeneralChat
      : row.node.kind === "group"
        ? Folder
        : row.node.kind === "project"
          ? LayoutDashboard
          : row.node.scopeProjectId
            ? Notebook
            : MessageSquare;
  return (
    <span className={styles.identityIcon}>
      <Glyph />
    </span>
  );
}

export function SpaceIdentity({ row }: { row: SpaceRowData }) {
  useAppLocale();
  const mutate = useOrganization((s) => s.mutate);
  if (row.node.entityId === "general") return <SpaceGlyph row={row} />;
  return (
    <span className={styles.iconSlot}>
      <IconButton
        className={styles.favorite}
        aria-pressed={row.pinned}
        label={`${row.title} ${row.pinned ? appCopy.space.unpin : appCopy.space.pinShort}`}
        draggable={false}
        onClick={(e) => {
          e.stopPropagation();
          void mutate({
            action: "pin",
            nodeKey: row.node.key,
            pinned: !row.pinned,
          });
        }}
        onKeyDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className={styles.normalIcon}>
          <SpaceGlyph row={row} />
        </span>
        <span className={styles.starIcon}>
          <Sparkles fill={row.pinned ? "currentColor" : "none"} />
        </span>
      </IconButton>
    </span>
  );
}
