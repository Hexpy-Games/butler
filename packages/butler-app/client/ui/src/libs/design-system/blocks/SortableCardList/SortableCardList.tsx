import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useMemo, useState, type HTMLAttributes, type ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { EmptyLine } from "../EmptyLine";
import { cn } from "../../lib/utils";
import { SortableCardItem, type SortableCardItemData } from "./SortableCardItem";
import styles from "./SortableCardList.module.css";

export type SortableCardListItem = SortableCardItemData;

export interface SortableCardListProps<TItem extends SortableCardListItem = SortableCardListItem>
  extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  items: TItem[];
  onReorder: (items: TItem[]) => void;
  onRemove?: (id: string) => void;
  empty?: ReactNode;
  emptyMessage?: string;
  disabled?: boolean;
}

export function reorderSortableCardItems<TItem extends SortableCardListItem>(
  items: TItem[],
  activeId: string,
  overId: string | null,
): TItem[] {
  if (!overId || activeId === overId) return items;
  const sourceIndex = items.findIndex((item) => item.id === activeId);
  const targetIndex = items.findIndex((item) => item.id === overId);
  if (sourceIndex < 0 || targetIndex < 0) return items;
  return arrayMove(items, sourceIndex, targetIndex);
}

export function SortableCardList<TItem extends SortableCardListItem>({
  title,
  description,
  actions,
  items,
  onReorder,
  onRemove,
  empty,
  emptyMessage = "No cards configured yet.",
  disabled = false,
  className,
  ...props
}: SortableCardListProps<TItem>) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const activeItem = useMemo(
    () => items.find((item) => item.id === activeId) ?? null,
    [activeId, items],
  );

  function handleDragStart(event: DragStartEvent) {
    const item = items.find((candidate) => candidate.id === String(event.active.id));
    setActiveId(item?.id ?? null);
    setAnnouncement(item ? `Dragging ${item.label ?? "card"}. Use arrow keys to move it.` : "");
  }

  function handleDragEnd(event: DragEndEvent) {
    const sourceId = String(event.active.id);
    const targetId = event.over ? String(event.over.id) : null;
    setActiveId(null);
    if (!targetId || sourceId === targetId) {
      setAnnouncement("");
      return;
    }
    const sourceIndex = items.findIndex((item) => item.id === sourceId);
    const nextItems = reorderSortableCardItems(items, sourceId, targetId);
    if (nextItems === items) return;
    onReorder(nextItems);
    const targetIndex = nextItems.findIndex((item) => item.id === sourceId);
    setAnnouncement(`Moved ${items[sourceIndex].label ?? "card"} to position ${targetIndex + 1}.`);
  }

  function handleDragCancel() {
    setActiveId(null);
    setAnnouncement("Reorder cancelled.");
  }

  return (
    <section className={cn(styles.list, className)} {...props}>
      {(title || description || actions) && (
        <Stack align="row" cross="start" justify="between" gap="md" className={styles.header}>
          <Stack gap="xs" className={styles.heading}>
            {title && <Typo.Body>{title}</Typo.Body>}
            {description && <Typo.Caption className={styles.headerDescription}>{description}</Typo.Caption>}
          </Stack>
          {actions}
        </Stack>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {items.length > 0 ? (
          <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
            <div className={styles.items} aria-disabled={disabled || undefined}>
              {items.map((item) => (
                <SortableCardItem
                  key={item.id}
                  item={item}
                  disabled={disabled}
                  onRemove={onRemove}
                />
              ))}
            </div>
            <DragOverlay dropAnimation={null}>
              {activeItem ? <SortableCardItem item={activeItem} overlay /> : null}
            </DragOverlay>
          </SortableContext>
        ) : (
          empty ?? <EmptyLine message={emptyMessage} />
        )}
      </DndContext>
      <span className={styles.srOnly} aria-live="polite">{announcement}</span>
    </section>
  );
}
