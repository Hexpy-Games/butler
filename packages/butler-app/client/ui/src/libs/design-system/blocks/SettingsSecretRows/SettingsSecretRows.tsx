import type { HTMLAttributes, ReactNode } from "react";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./SettingsSecretRows.module.css";

export interface SettingsSecretRowsProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  actions?: ReactNode;
  emptyState?: ReactNode;
  children?: ReactNode;
}

export interface SettingsSecretRowProps extends HTMLAttributes<HTMLDivElement> {
  sourceControl: ReactNode;
  keyControl: ReactNode;
  valueControl: ReactNode;
  actionControl: ReactNode;
}

export function SettingsSecretRows({
  title,
  actions,
  emptyState,
  children,
  className,
  ...props
}: SettingsSecretRowsProps) {
  return (
    <div className={cn(styles.root, className)} {...props}>
      <div className={styles.header}>
        <Typo.Body>{title}</Typo.Body>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      <div className={styles.rowList}>{children}</div>
      {emptyState ? (
        <Typo.Caption className={styles.empty}>{emptyState}</Typo.Caption>
      ) : null}
    </div>
  );
}

export function SettingsSecretRow({
  sourceControl,
  keyControl,
  valueControl,
  actionControl,
  className,
  ...props
}: SettingsSecretRowProps) {
  return (
    <div className={cn(styles.row, className)} {...props}>
      <div className={styles.sourceCell}>{sourceControl}</div>
      <div className={styles.keyCell}>{keyControl}</div>
      <div className={styles.valueCell}>{valueControl}</div>
      <div className={styles.actionCell}>{actionControl}</div>
    </div>
  );
}
