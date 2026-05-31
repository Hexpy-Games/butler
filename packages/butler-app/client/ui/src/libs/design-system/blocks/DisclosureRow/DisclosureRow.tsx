import type { HTMLAttributes, ReactNode } from "react";
import { Clickable } from "../../components/Clickable";
import { ChevronDown, ChevronRight } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./DisclosureRow.module.css";

export interface DisclosureRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  icon?: ReactNode;
  surface?: "selection" | "plain";
  controlsId?: string;
  open?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}

export function DisclosureRow({
  title,
  description,
  meta,
  icon,
  surface = "selection",
  controlsId,
  open = false,
  onToggle,
  children,
  className,
  ...props
}: DisclosureRowProps) {
  return (
    <div
      className={cn(
        styles.root,
        open && styles.open,
        surface === "plain" && styles.plain,
        className,
      )}
      data-surface={surface}
      {...props}
    >
      <Clickable
        aria-controls={controlsId}
        className={styles.trigger}
        aria-expanded={open}
        stretch
        onClick={onToggle}
      >
        <span className={cn(styles.labelRegion, !icon && styles.noIcon)}>
          <span className={styles.chevron} aria-hidden="true">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          {icon ? (
            <span
              className={cn(styles.icon, description && styles.withDescription)}
              data-slot="disclosure-row-icon"
            >
              {icon}
            </span>
          ) : null}
          <Stack gap="xs" className={styles.content}>
            <Typo.Body className={styles.title} data-slot="disclosure-row-title">{title}</Typo.Body>
            {description ? <Typo.Caption className={styles.description}>{description}</Typo.Caption> : null}
          </Stack>
        </span>
        {meta ? <Typo.Caption className={styles.meta}>{meta}</Typo.Caption> : null}
      </Clickable>
      {open && children ? <div className={styles.panel}>{children}</div> : null}
    </div>
  );
}
