import type { ReactNode } from "react";
import { IconSlot } from "../../components/IconSlot";
import { Typo } from "../../components/Typo";
import { useStepSortableScope, type StepSortableRowContext } from "./stepSortableContext";
import { StaticGrip, StepSortableGrip, stopEvent } from "./StepSortableGrip";
import type { StepSortableItem } from "./stepSortableModel";
import styles from "./StepSortableList.module.css";

export interface StepSortableRowProps {
  item: StepSortableItem;
  context: StepSortableRowContext;
  /** The grip's drag: one item, or the whole step (a collapsed 묶음). Null: no grip (pinned). */
  grip: { dragId: string; label: string; movable: boolean } | null;
  /** Show the marker (a fanned 묶음 shows the step number on its first card only). */
  marker?: boolean;
}

function Grip({ grip, lifted }: { grip: StepSortableRowProps["grip"]; lifted: boolean }) {
  if (!grip || !grip.movable) return null;
  return lifted ? <StaticGrip /> : <StepSortableGrip {...grip} />;
}

/** Trailing control, or its room (statuses line up down the list). */
function Trailing({ children, className }: { children: ReactNode; className: string }) {
  if (!children) return <div className={styles.menuRoom} aria-hidden="true" />;
  return <div className={className} onClick={stopEvent} onMouseDown={stopEvent} onTouchStart={stopEvent}>{children}</div>;
}

/**
 * One row (a single step's card or a collapsed 묶음's front):
 * `[grip] [number or status glyph] [title (more) ........ meta] / [caption] [⋯]`; the meta, then `more`,
 * wrap before the title truncates.
 * A fanned 묶음's card is compact: the title (two lines), then grip · caption · ⋯.
 */
export function StepSortableRow({ item, context, grip, marker = true }: StepSortableRowProps) {
  const scope = useStepSortableScope();
  const slots = scope.renderItem(item, context);
  const dragging = !context.lifted && scope.view.itemIds.includes(item.id) && scope.view.mode !== null;
  const muted = item.done ? "secondary" : undefined;
  if (context.expanded) {
    return (
      <div className={styles.fanCard} data-step-item={item.id} data-dragging={dragging || undefined}>
        <div className={styles.fanTitle}>
          {marker && slots.marker ? <IconSlot size="md" minHeight="line" tone="tertiary">{slots.marker}</IconSlot> : null}
          <Typo.Body lineClamp={2} tone={muted}>{slots.title}</Typo.Body>
        </div>
        <div className={styles.controlLine}>
          {grip?.movable ? <div className={styles.lineLead}><Grip grip={grip} lifted={context.lifted} /></div> : null}
          <div className={styles.lineCaption}><Typo.Caption tone="secondary" truncate>{slots.caption}</Typo.Caption></div>
          {slots.trailing && !context.lifted ? <Trailing className={styles.lineMenu}>{slots.trailing}</Trailing> : null}
        </div>
      </div>
    );
  }
  return (
    <div className={styles.row} data-step-item={item.id}>
      <div className={styles.leadControl}><Grip grip={grip} lifted={context.lifted} /></div>
      <IconSlot size="md" minHeight="line" tone="tertiary">{marker ? slots.marker : null}</IconSlot>
      <div className={styles.text}>
        <div className={styles.titleLine}>
          <div className={styles.title}>
            <Typo.Body truncate tone={muted}>{slots.title}</Typo.Body>
            {slots.more ? <Typo.Body tone="tertiary" wrap="nowrap">{slots.more}</Typo.Body> : null}
          </div>
          {slots.meta ? <Typo.Caption tone="tertiary" numeric="tabular" wrap="nowrap">{slots.meta}</Typo.Caption> : null}
        </div>
        {slots.caption ? <Typo.Caption tone={item.done ? "tertiary" : "secondary"} truncate>{slots.caption}</Typo.Caption> : null}
      </div>
      <Trailing className={styles.trailing}>{context.lifted ? null : slots.trailing}</Trailing>
    </div>
  );
}
