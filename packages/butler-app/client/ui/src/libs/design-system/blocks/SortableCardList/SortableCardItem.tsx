import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ReactNode } from "react";
import { Card } from "../../components/Card";
import { IconButton } from "../../components/IconButton";
import { GripVertical, X } from "../../components/Icons";
import { Separator } from "../../components/Separator";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import { motionDuration, prefersReducedMotion } from "../../lib/motion";
import styles from "./SortableCardList.module.css";
import { dsClass } from "../../lib/internal";

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
  // Neighbors slide aside on the DS motion tokens; reduced motion moves them at once.
  const sortable = useSortable({
    id: item.id,
    disabled: disabled || overlay,
    transition: prefersReducedMotion()
      ? null
      : { duration: motionDuration("base"), easing: "var(--motion-ease-standard)" },
  });
  const transform = CSS.Transform.toString(sortable.transform);
  const label = item.label ?? (typeof item.title === "string" ? item.title : "card");
  const showDropIndicator = !overlay && sortable.isOver && !sortable.isDragging;

  return (
    <div
      ref={overlay ? undefined : sortable.setNodeRef}
      className={cn(styles.item, sortable.isDragging && styles.dragging, overlay && styles.overlay)}
      style={overlay ? undefined : {
        transform: transform || undefined,
        transition: sortable.transition || undefined,
      }}
      data-sortable-id={item.id}
      data-drop-target={showDropIndicator ? "true" : undefined}
    >
      {showDropIndicator && (
        <Separator
          className={dsClass(styles.dropIndicator)}
          data-drop-indicator="true"
          decorative
          aria-hidden="true"
          space="xs"
          tone="accent"
        />
      )}
      <Card className={dsClass(styles.card)} padding="sm">
        {!overlay && (
          <IconButton
            className={dsClass(styles.handle)}
            label={`Reorder ${label}`}
            disabled={disabled}
            data-sortable-handle="true"
            {...sortable.attributes}
            {...sortable.listeners}
            aria-roledescription="sortable"
          >
            <GripVertical size="md" />
          </IconButton>
        )}
        {item.leading && <span className={styles.leading} aria-hidden="true">{item.leading}</span>}
        <Stack gap="xs" className={dsClass(styles.content)}>
          <div className={styles.titleRow}>
            <Typo.Body>{item.title}</Typo.Body>
            {item.meta && <Typo.Caption className={dsClass(styles.meta)}>{item.meta}</Typo.Caption>}
          </div>
          {item.description && <Typo.Caption className={dsClass(styles.description)}>{item.description}</Typo.Caption>}
        </Stack>
        {item.actions && <div className={styles.actions}>{item.actions}</div>}
        {onRemove && !overlay && (
          <IconButton
            label={`Remove ${label}`}
            disabled={disabled}
            onClick={() => onRemove(item.id)}
          >
            <X size="md" />
          </IconButton>
        )}
      </Card>
    </div>
  );
}
