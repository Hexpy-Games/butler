import { useAppLocale } from "@/app/copy.ts";
import {
  IconSlot,
  Folder,
  Briefcase,
  MessageSquare,
  Notebook,
  GeneralChat,
} from "@/butler-ds";
import type { SpaceRowData } from "@/app/space/projection";

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
    <IconSlot size="sidebar">
      <Glyph />
    </IconSlot>
  );
}
