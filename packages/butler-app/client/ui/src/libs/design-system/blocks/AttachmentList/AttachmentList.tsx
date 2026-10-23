import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { ReactNode, Ref } from "react";
import type { TriggerProps } from "./AttachmentTiles";
import { Button } from "../../components/Button";
import { FileText, X } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Tooltip } from "../../components/Tooltip";
import { Typo } from "../../components/Typo";
import { windowDragClassName, type WindowDragProps } from "../../lib/windowDrag";
import { ElementChip } from "../ElementChip";
import styles from "./AttachmentList.module.css";
import { AttachmentTiles } from "./AttachmentTiles";
import { dsClass } from "../../lib/internal";

export interface AttachmentListItem {
  id: string;
  name: string;
  meta?: string;
  href?: string;
  icon?: ReactNode;
  thumbnail?: {
    src: string;
    alt?: string;
  };
  /** Kept but not sendable; a short reason (a few words) shown in the name tooltip. */
  blockedReason?: string;
  /**
   * A picked page element (ElementChip kind): `thumbnail` is its crop, `name` its title, `site` its host.
   * Element chips lead the list in one wrapping row, removable only when `onRemove` is set.
   */
  element?: { site: string };
  /** A video file (tiles): its first frame (metadata only, muted), a play badge and its length. */
  video?: { src: string };
  /** Tiles: the file-type label on a file face ("PDF", "DOCX"); the container localizes an unknown type. */
  extension?: string;
}

export interface AttachmentListProps extends DsPrivateStyleProps, WindowDragProps {
  items: AttachmentListItem[];
  emptyLabel?: string;
  onRemove?: (id: string) => void;
  /** `tiles`: square tiles (cover picture, video first frame or file type); see `tileLayout`. */
  variant?: "list" | "chips" | "tiles";
  /**
   * Tiles: `row` 64px squares in one sideways-scrolling row with the edge fade (composer); `wrap` 96px
   * squares, end-aligned and wrapping, with the size line (a sent message). Default `wrap`.
   */
  tileLayout?: "row" | "wrap";
  /**
   * Opens an item in the app (a viewer or the inspector). The name (list, chips) or the tile becomes a
   * button, and `href` is not used; without it a `href` stays a link.
   */
  onOpen?: (item: AttachmentListItem) => void;
  /** The remove button label: a word ("Remove"; the name is appended) or the whole label for a name. */
  removeLabel?: string | ((name: string) => string);
}

export function AttachmentList({
  items,
  emptyLabel = "No attachments",
  onRemove,
  className,
  variant = "list",
  windowDrag,
  removeLabel = "Remove",
  tileLayout = "wrap",
  onOpen,
}: AttachmentListProps) {
  const removeText = typeof removeLabel === "function" ? removeLabel : (name: string) => `${removeLabel} ${name}`;
  if (items.length === 0) {
    return (
      <Typo.Caption className={dsClass(styles.empty, windowDragClassName(windowDrag), className)}>
        {emptyLabel}
      </Typo.Caption>
    );
  }

  if (variant === "tiles") {
    return <AttachmentTiles items={items} layout={tileLayout} onOpen={onOpen} onRemove={onRemove} removeLabel={removeText}
      windowDrag={windowDrag} className={className} />;
  }

  return (
    <Stack
      className={dsClass(styles.list, styles[variant], windowDragClassName(windowDrag), className)}
      data-slot="attachment-list"
      gap={variant === "chips" ? "none" : "xs"}
    >
      {items.some((item) => item.element) ? (
        <div className={styles.elements} data-slot="attachment-elements">
          {items.filter((item) => item.element).map((item) => (
            <ElementChip key={item.id} src={item.thumbnail?.src} title={item.name} site={item.element!.site}
              removeLabel={typeof removeLabel === "string" ? removeLabel : undefined} onRemove={onRemove ? () => onRemove(item.id) : undefined} />
          ))}
        </div>
      ) : null}
      {items.filter((item) => !item.element).map((item) => (
        <div
          className={styles.item}
          data-blocked={item.blockedReason ? "true" : undefined}
          data-slot="attachment-item"
          key={item.id}
        >
          {item.thumbnail ? (
            <span className={styles.thumbnail} data-slot="attachment-thumbnail">
              <img
                alt={item.thumbnail.alt ?? item.name}
                src={item.thumbnail.src}
              />
            </span>
          ) : (
            <span
              className={styles.icon}
              data-slot="attachment-icon"
              aria-hidden="true"
            >
              {item.icon ?? <FileText size="sm" />}
            </span>
          )}
          <Tooltip label={item.blockedReason ?? item.name}>
            <ItemName item={item} onOpen={onOpen} />
          </Tooltip>
          {onRemove ? (
            <Button
              aria-label={removeText(item.name)}
              size="icon-xs"
              variant="borderless"
              type="button"
              onClick={() => onRemove(item.id)}
            >
              <X size="sm" />
            </Button>
          ) : null}
          {item.meta ? (
            <Typo.Caption className={dsClass(styles.meta)} data-slot="attachment-meta">
              {item.meta}
            </Typo.Caption>
          ) : null}
        </div>
      ))}
    </Stack>
  );
}

/** The name: a button with `onOpen`, else a link with `href`, else text. Tooltip's trigger props pass through. */
function ItemName({ item, onOpen, ref, ...trigger }: { item: AttachmentListItem; onOpen?: (item: AttachmentListItem) => void } & TriggerProps) {
  const shared = { ...trigger, "aria-label": blockedLabel(item), className: styles.name, "data-slot": "attachment-name" };
  if (onOpen) return <button {...shared} ref={ref as Ref<HTMLButtonElement>} type="button" onClick={() => onOpen(item)}>{item.name}</button>;
  if (item.href) return <a {...shared} ref={ref as Ref<HTMLAnchorElement>} href={item.href} target="_blank" rel="noreferrer">{item.name}</a>;
  return <span {...shared} ref={ref as Ref<HTMLSpanElement>}>{item.name}</span>;
}

function blockedLabel(item: AttachmentListItem): string | undefined {
  return item.blockedReason ? `${item.name}, ${item.blockedReason}` : undefined;
}
