import { Children, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { Card } from "../../components/Card";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./CardList.module.css";

export interface CardListProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  actions?: ReactNode;
  empty?: ReactNode;
  maxVisibleRows?: number;
  children: ReactNode;
}

export interface CardListItemProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  selected?: boolean;
}

export function CardList({
  title,
  actions,
  empty,
  maxVisibleRows,
  children,
  className,
  style,
  ...props
}: CardListProps) {
  const hasChildren = Children.count(children) > 0;
  const listStyle = {
    ...style,
    ...(maxVisibleRows
      ? { "--card-list-max-height": `${maxVisibleRows * 80 - 8}px` }
      : {}),
  } as CSSProperties;

  return (
    <section className={cn(styles.cardList, className)} style={listStyle} {...props}>
      {(title || actions) && (
        <div className={styles.header}>
          {title && <Typo.Body className={styles.heading}>{title}</Typo.Body>}
          {actions}
        </div>
      )}
      <div className={styles.scroller}>{hasChildren ? children : empty}</div>
    </section>
  );
}

export function CardListItem({
  icon,
  title,
  description,
  meta,
  actions,
  selected,
  className,
  ...props
}: CardListItemProps) {
  return (
    <Card
      className={cn(styles.item, className)}
      data-has-icon={icon ? "true" : undefined}
      padding="md"
      selected={selected}
      {...props}
    >
      {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
      <Stack gap="xs" className={styles.content}>
        <div className={styles.titleRow}>
          <Typo.Body className={styles.title}>{title}</Typo.Body>
          {meta && <Typo.Caption className={styles.meta}>{meta}</Typo.Caption>}
        </div>
        {description && (
          <Typo.Caption className={styles.description}>{description}</Typo.Caption>
        )}
      </Stack>
      {actions && <div className={styles.actions}>{actions}</div>}
    </Card>
  );
}
