import type { DsBaseProps } from "../../lib/dsProps";
import type { HTMLAttributes, ReactNode } from "react";
import { ComposerAdjunctPanel } from "../ComposerAdjunctPanel";
import {
  WorkerActivityRow,
  type WorkerActivityRowProps,
} from "../WorkerActivityRow";
import styles from "./WorkerActivityPanel.module.css";
import { dsClass } from "../../lib/internal";

export interface WorkerActivityPanelItem extends Omit<
  WorkerActivityRowProps,
  "compact"
> {
  id: string;
}

export interface WorkerActivityPanelProps extends Omit<
  DsBaseProps<HTMLAttributes<HTMLElement>>,
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
      className={dsClass(styles.panel, className)}
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
