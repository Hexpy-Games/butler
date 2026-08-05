import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ReactNode } from "react";
import { Card } from "../../components/Card";
import { IconButton } from "../../components/IconButton";
import { DragHandle, X } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./SortableCardList.module.css";

export interface SortableCardItemData {
  id: string;
  label?: string;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
}

interface SortableCardItemProps {
  item: SortableCardItemData;
  disabled?: boolean;
  onRemove?: (id: string) => void;
  overlay?: boolean;
}

export function SortableCardItem({
  item,
  disabled = false,
  onRemove,
  overlay = false,
}: SortableCardItemProps) {
  const sortable = useSortable({ id: item.id, disabled: disabled || overlay });
  const transform = CSS.Transform.toString(sortable.transform);
  const label = item.label ?? (typeof item.title === "string" ? item.title : "card");

  return (
    <div
      ref={overlay ? undefined : sortable.setNodeRef}
      className={cn(styles.item, sortable.isDragging && styles.dragging, overlay && styles.overlay)}
      style={overlay ? undefined : {
        transform: transform || undefined,
        transition: sortable.transition || undefined,
      }}
      data-sortable-id={item.id}
    >
      <Card className={styles.card} padding="sm">
        {!overlay && (
          <IconButton
            className={styles.handle}
            label={`Reorder ${label}`}
            disabled={disabled}
            data-sortable-handle="true"
            {...sortable.attributes}
            {...sortable.listeners}
            aria-roledescription="sortable"
          >
            <DragHandle size={16} />
          </IconButton>
        )}
        {item.leading && <span className={styles.leading} aria-hidden="true">{item.leading}</span>}
        <Stack gap="xs" className={styles.content}>
          <div className={styles.titleRow}>
            <Typo.Body>{item.title}</Typo.Body>
            {item.meta && <Typo.Caption className={styles.meta}>{item.meta}</Typo.Caption>}
          </div>
          {item.description && <Typo.Caption className={styles.description}>{item.description}</Typo.Caption>}
        </Stack>
        {item.actions && <div className={styles.actions}>{item.actions}</div>}
        {onRemove && !overlay && (
          <IconButton
            label={`Remove ${label}`}
            disabled={disabled}
            onClick={() => onRemove(item.id)}
          >
            <X size={16} />
          </IconButton>
        )}
      </Card>
    </div>
  );
}
