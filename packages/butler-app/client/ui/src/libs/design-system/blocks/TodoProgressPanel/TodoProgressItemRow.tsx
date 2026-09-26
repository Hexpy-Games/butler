import { memo } from "react";
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleX,
  Minus,
} from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { Spinner } from "../../components/Spinner";
import type {
  TodoProgressPanelItem,
  TodoProgressPanelItemState,
} from "./TodoProgressPanel";
import styles from "./TodoProgressPanel.module.css";
import { dsClass } from "../../lib/internal";

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
        <Typo.Body
          as="span"
          aria-label={item.fullTitle ?? item.title}
          className={dsClass(styles.title)}
          title={item.fullTitle ?? item.title}
        >
          {item.title}
        </Typo.Body>
      </span>
      <Typo.Caption as="span" className={dsClass(styles.status)}>
        {item.statusLabel}
      </Typo.Caption>
    </li>
  );
}, (previous, next) =>
  previous.item.id === next.item.id &&
  previous.item.title === next.item.title &&
  previous.item.fullTitle === next.item.fullTitle &&
  previous.item.state === next.item.state &&
  previous.item.statusLabel === next.item.statusLabel,
);

function itemIcon(state: TodoProgressPanelItemState) {
  if (state === "completed") return <CheckCircle2 size="md" />;
  if (state === "blocked") return <CircleAlert size="md" />;
  if (state === "skipped") return <Minus size="md" />;
  if (state === "correction-required" || state === "stopped")
    return <CircleX size="md" />;
  if (state === "running" || state === "reviewing")
    return <Spinner />;
  return <Circle size="md" />;
}
