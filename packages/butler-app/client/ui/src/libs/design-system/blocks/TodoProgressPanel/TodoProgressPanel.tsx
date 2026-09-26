import type { DsBaseProps } from "../../lib/dsProps";
import type { HTMLAttributes } from "react";
import { ListChecks } from "../../components/Icons";
import { ComposerAdjunctPanel } from "../ComposerAdjunctPanel";
import styles from "./TodoProgressPanel.module.css";
import { TodoProgressItemRow } from "./TodoProgressItemRow";
import { dsClass } from "../../lib/internal";

export type TodoProgressPanelItemState =
  | "pending"
  | "running"
  | "reviewing"
  | "completed"
  | "correction-required"
  | "blocked"
  | "skipped"
  | "stopped";

export interface TodoProgressPanelItem {
  id: string;
  title: string;
  fullTitle?: string;
  state: TodoProgressPanelItemState;
  statusLabel: string;
}

export interface TodoProgressPanelProps extends Omit<
  DsBaseProps<HTMLAttributes<HTMLElement>>,
  "title"
> {
  heading: string;
  items: TodoProgressPanelItem[];
  ariaLabel?: string;
}

export function TodoProgressPanel({
  heading,
  items,
  ariaLabel,
  className,
  ...props
}: TodoProgressPanelProps) {
  if (items.length === 0) return null;
  const currentItem = items.find((item) =>
    item.state === "running" ||
    item.state === "reviewing" ||
    item.state === "correction-required" ||
    item.state === "blocked",
  );
  const collapsedSummary = currentItem
    ? `${currentItem.statusLabel}: ${currentItem.title}`
    : undefined;

  return (
    <ComposerAdjunctPanel
      role="region"
      className={dsClass(styles.panel, className)}
      aria-label={ariaLabel ?? heading}
      heading={heading}
      icon={<ListChecks size="md" />}
      collapsedSummary={collapsedSummary}
      {...props}
    >
      <ul className={styles.list}>
        {items.map((item) => <TodoProgressItemRow item={item} key={item.id} />)}
      </ul>
    </ComposerAdjunctPanel>
  );
}
