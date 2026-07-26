import { memo } from "react";
import { CheckCircle2, Circle, CircleX, LoaderCircle } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import type {
  TodoProgressPanelItem,
  TodoProgressPanelItemState,
} from "./TodoProgressPanel";
import styles from "./TodoProgressPanel.module.css";

export const TodoProgressItemRow = memo(function TodoProgressItemRow({
  item,
}: {
  item: TodoProgressPanelItem;
}) {
  return (
    <li className={styles.item} data-state={item.state}>
      <span className={styles.marker} aria-hidden="true">
        {itemIcon(item.state)}
      </span>
      <span className={styles.content}>
        {item.groupTitle ? (
          <Typo.Caption as="span" className={styles.group} title={item.groupTitle}>
            {item.groupTitle}
          </Typo.Caption>
        ) : null}
        <Typo.Body as="span" className={styles.title} title={item.title}>
          {item.title}
        </Typo.Body>
      </span>
      <Typo.Caption as="span" className={styles.status}>
        {item.statusLabel}
      </Typo.Caption>
    </li>
  );
}, (previous, next) =>
  previous.item.id === next.item.id &&
  previous.item.title === next.item.title &&
  previous.item.groupTitle === next.item.groupTitle &&
  previous.item.state === next.item.state &&
  previous.item.statusLabel === next.item.statusLabel,
);

function itemIcon(state: TodoProgressPanelItemState) {
  if (state === "completed") return <CheckCircle2 size={15} />;
  if (state === "correction-required" || state === "stopped")
    return <CircleX size={15} />;
  if (state === "running" || state === "reviewing")
    return <LoaderCircle size={15} />;
  return <Circle size={15} />;
}
