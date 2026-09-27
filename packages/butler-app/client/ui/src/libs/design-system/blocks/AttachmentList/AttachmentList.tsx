import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { ReactNode } from "react";
import { Button } from "../../components/Button";
import { FileText, X } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Tooltip } from "../../components/Tooltip";
import { Typo } from "../../components/Typo";
import { windowDragClassName, type WindowDragProps } from "../../lib/windowDrag";
import styles from "./AttachmentList.module.css";
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
}

export interface AttachmentListProps extends DsPrivateStyleProps, WindowDragProps {
  items: AttachmentListItem[];
  emptyLabel?: string;
  onRemove?: (id: string) => void;
  variant?: "list" | "chips";
}

export function AttachmentList({
  items,
  emptyLabel = "No attachments",
  onRemove,
  className,
  variant = "list",
  windowDrag,
}: AttachmentListProps) {
  if (items.length === 0) {
    return (
      <Typo.Caption className={dsClass(styles.empty, windowDragClassName(windowDrag), className)}>
        {emptyLabel}
      </Typo.Caption>
    );
  }

  return (
    <Stack
      className={dsClass(styles.list, styles[variant], windowDragClassName(windowDrag), className)}
      data-slot="attachment-list"
      gap={variant === "chips" ? "none" : "xs"}
    >
      {items.map((item) => (
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
          {item.href ? (
            <Tooltip label={item.blockedReason ?? item.name}>
              <a
                aria-label={blockedLabel(item)}
                className={styles.name}
                data-slot="attachment-name"
                href={item.href}
                target="_blank"
                rel="noreferrer"
              >
                {item.name}
              </a>
            </Tooltip>
          ) : (
            <Tooltip label={item.blockedReason ?? item.name}>
              <span aria-label={blockedLabel(item)} className={styles.name} data-slot="attachment-name">
                {item.name}
              </span>
            </Tooltip>
          )}
          {onRemove ? (
            <Button
              aria-label={`Remove ${item.name}`}
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

function blockedLabel(item: AttachmentListItem): string | undefined {
  return item.blockedReason ? `${item.name}, ${item.blockedReason}` : undefined;
}
