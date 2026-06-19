import type { ReactNode } from "react";
import { Clickable } from "../../components/Clickable";
import { MessageSquarePlus } from "../../components/Icons";
import { cn } from "../../lib/utils";
import { ListRow } from "../ListRow";
import { RowActionCluster } from "../RowActionCluster";
import styles from "./SessionRow.module.css";

export interface SessionRowProps {
  title: string;
  description?: ReactNode;
  meta?: ReactNode;
  active?: boolean;
  actions?: ReactNode;
  card?: boolean;
  dataTestClass?: string;
  showIcon?: boolean;
  onSelect?: () => void;
}

export function SessionRow({
  title,
  description,
  meta,
  active = false,
  actions,
  card = false,
  dataTestClass,
  showIcon = true,
  onSelect,
}: SessionRowProps) {
  return (
    <Clickable
      aria-current={active ? "page" : undefined}
      className={cn(styles.row, active && styles.active, card && styles.card)}
      data-test-class={dataTestClass}
      onClick={onSelect}
      role={onSelect ? "button" : undefined}
      stretch
    >
      <ListRow
        icon={showIcon ? <MessageSquarePlus size={15} /> : undefined}
        title={title}
        description={description}
        meta={meta}
      />
      {actions ? <RowActionCluster>{actions}</RowActionCluster> : null}
    </Clickable>
  );
}
