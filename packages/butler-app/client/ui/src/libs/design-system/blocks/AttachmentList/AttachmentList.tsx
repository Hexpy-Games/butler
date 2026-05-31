import type { ReactNode } from "react";
import { Button } from "../../components/Button";
import { FileText, X } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Tooltip } from "../../components/Tooltip";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./AttachmentList.module.css";

export interface AttachmentListItem {
  id: string;
  name: string;
  meta?: string;
  href?: string;
  icon?: ReactNode;
}

export interface AttachmentListProps {
  items: AttachmentListItem[];
  emptyLabel?: string;
  onRemove?: (id: string) => void;
  className?: string;
  variant?: "list" | "chips";
}

export function AttachmentList({
  items,
  emptyLabel = "No attachments",
  onRemove,
  className,
  variant = "list",
}: AttachmentListProps) {
  if (items.length === 0) {
    return (
      <Typo.Caption className={cn(styles.empty, className)}>
        {emptyLabel}
      </Typo.Caption>
    );
  }

  return (
    <Stack
      className={cn(styles.list, styles[variant], className)}
      data-slot="attachment-list"
      gap={variant === "chips" ? "none" : "xs"}
    >
      {items.map((item) => (
        <div className={styles.item} data-slot="attachment-item" key={item.id}>
          <span
            className={styles.icon}
            data-slot="attachment-icon"
            aria-hidden="true"
          >
            {item.icon ?? <FileText size={14} />}
          </span>
          {item.href ? (
            <Tooltip label={item.name}>
              <a
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
            <Tooltip label={item.name}>
              <span className={styles.name} data-slot="attachment-name">
                {item.name}
              </span>
            </Tooltip>
          )}
          {item.meta ? (
            <Typo.Caption className={styles.meta} data-slot="attachment-meta">
              {item.meta}
            </Typo.Caption>
          ) : null}
          {onRemove ? (
            <Button
              aria-label={`Remove ${item.name}`}
              size="icon-xs"
              variant="borderless"
              type="button"
              onClick={() => onRemove(item.id)}
            >
              <X size={13} />
            </Button>
          ) : null}
        </div>
      ))}
    </Stack>
  );
}
