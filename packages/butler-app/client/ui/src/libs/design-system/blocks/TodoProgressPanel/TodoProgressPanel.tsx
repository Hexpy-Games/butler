import type { HTMLAttributes } from "react";
import { ListChecks } from "../../components/Icons";
import { cn } from "../../lib/utils";
import { ComposerAdjunctPanel } from "../ComposerAdjunctPanel";
import styles from "./TodoProgressPanel.module.css";
import { TodoProgressItemRow } from "./TodoProgressItemRow";

export type TodoProgressPanelItemState =
  | "pending"
  | "running"
  | "reviewing"
  | "completed"
  | "correction-required"
  | "stopped";

export interface TodoProgressPanelItem {
  id: string;
  title: string;
  groupTitle?: string;
  state: TodoProgressPanelItemState;
  statusLabel: string;
}

export interface TodoProgressPanelProps extends Omit<
  HTMLAttributes<HTMLElement>,
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
    item.state === "correction-required",
  );
  const collapsedSummary = currentItem
    ? `${currentItem.statusLabel}: ${currentItem.title}`
    : undefined;

  return (
    <ComposerAdjunctPanel
      role="region"
      className={cn(styles.panel, className)}
      aria-label={ariaLabel ?? heading}
      heading={heading}
      icon={<ListChecks size={15} />}
      collapsedSummary={collapsedSummary}
      {...props}
    >
      <ul className={styles.list}>
        {items.map((item) => <TodoProgressItemRow item={item} key={item.id} />)}
      </ul>
    </ComposerAdjunctPanel>
  );
}
