import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { ComposerAdjunctPanel } from "../ComposerAdjunctPanel";
import {
  WorkerActivityRow,
  type WorkerActivityRowProps,
} from "../WorkerActivityRow";
import styles from "./WorkerActivityPanel.module.css";

export interface WorkerActivityPanelItem extends Omit<
  WorkerActivityRowProps,
  "compact"
> {
  id: string;
}

export interface WorkerActivityPanelProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "title"
> {
  heading?: ReactNode;
  collapsedSummary?: ReactNode;
  items: WorkerActivityPanelItem[];
}

export function WorkerActivityPanel({
  heading,
  collapsedSummary,
  items,
  className,
  ...props
}: WorkerActivityPanelProps) {
  if (items.length === 0) return null;

  return (
    <ComposerAdjunctPanel
      className={cn(styles.panel, className)}
      heading={heading}
      collapsedSummary={collapsedSummary}
      {...props}
    >
      <div className={styles.list}>
        {items.map((item) => (
          <WorkerActivityRow compact key={item.id} {...item} />
        ))}
      </div>
    </ComposerAdjunctPanel>
  );
}
