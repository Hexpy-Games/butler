import type { DsBaseProps } from "../../lib/dsProps";
import type { HTMLAttributes, ReactNode } from "react";
import { Clickable } from "../../components/Clickable";
import { Collapsible } from "../../components/Collapsible";
import { ChevronDown, ChevronRight } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./DisclosureRow.module.css";
import { dsClass } from "../../lib/internal";

export interface DisclosureRowProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "title"> {
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
        icon && styles.withIcon,
        surface === "plain" && styles.plain,
        className,
      )}
      data-surface={surface}
      {...props}
    >
      <Clickable
        aria-controls={controlsId}
        className={dsClass(cn(styles.trigger, !icon && styles.noIcon))}
        aria-expanded={open}
        stretch
        onClick={onToggle}
      >
        <span className={styles.chevron} aria-hidden="true">
          {open ? <ChevronDown size="sm" /> : <ChevronRight size="sm" />}
        </span>
        {icon ? <span className={styles.icon} data-slot="disclosure-row-icon">{icon}</span> : null}
        <Typo.Body className={dsClass(styles.title)} data-slot="disclosure-row-title">{title}</Typo.Body>
        {meta ? <Typo.Caption className={dsClass(styles.meta)} data-slot="disclosure-row-meta">{meta}</Typo.Caption> : null}
        {description ? <Typo.Caption className={dsClass(styles.description)}>{description}</Typo.Caption> : null}
      </Clickable>
      {children ? (
        <Collapsible open={open}>
          <div className={styles.panel}>{children}</div>
        </Collapsible>
      ) : null}
    </div>
  );
}
