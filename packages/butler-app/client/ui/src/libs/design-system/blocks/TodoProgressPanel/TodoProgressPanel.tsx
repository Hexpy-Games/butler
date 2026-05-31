import type { HTMLAttributes } from "react";
import {
  CheckCircle2,
  Circle,
  CircleX,
  ListChecks,
  LoaderCircle,
} from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import { ComposerAdjunctPanel } from "../ComposerAdjunctPanel";
import styles from "./TodoProgressPanel.module.css";

export type TodoProgressPanelItemState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TodoProgressPanelItem {
  id: string;
  title: string;
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
  const currentItem = items.find((item) => item.state === "running");
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
        {items.map((item) => (
          <li className={styles.item} data-state={item.state} key={item.id}>
            <span className={styles.marker} aria-hidden="true">
              {itemIcon(item.state)}
            </span>
            <Typo.Body as="span" className={styles.title} title={item.title}>
              {item.title}
            </Typo.Body>
            <Typo.Caption as="span" className={styles.status}>
              {item.statusLabel}
            </Typo.Caption>
          </li>
        ))}
      </ul>
    </ComposerAdjunctPanel>
  );
}

function itemIcon(state: TodoProgressPanelItemState) {
  if (state === "completed") return <CheckCircle2 size={15} />;
  if (state === "failed" || state === "cancelled") return <CircleX size={15} />;
  if (state === "running") return <LoaderCircle size={15} />;
  return <Circle size={15} />;
}
