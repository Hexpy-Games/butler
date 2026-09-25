import { useAppLocale } from "@/app/copy.ts";
import {
  Folder,
  Briefcase,
  MessageSquare,
  Notebook,
  GeneralChat,
} from "@/butler-ds";
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
          ? Briefcase
          : row.node.scopeProjectId
            ? Notebook
            : MessageSquare;
  return (
    <span className={styles.identityIcon}>
      <Glyph />
    </span>
  );
}
