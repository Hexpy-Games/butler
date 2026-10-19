import type { DsBaseProps } from "../../lib/dsProps";
import type { HTMLAttributes, ReactNode } from "react";
import { Clickable } from "../../components/Clickable";
import { Collapsible } from "../../components/Collapsible";
import { ChevronDown, ChevronRight } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { useReducedMotion } from "../../lib/useReducedMotion";
import { cn } from "../../lib/utils";
import styles from "./DisclosureRow.module.css";
import { dsClass, dsStyle } from "../../lib/internal";
import { DisclosureRowIndentReset, useDisclosureRowIndent } from "./DisclosureRowIndent";

/**
 * leading (default): a chevron column before the title. trailing: a chevron
 * after the meta that turns down when open (log lists). none: no chevron,
 * the row itself is the cue (trace steps).
 */
export type DisclosureRowAffordance = "leading" | "trailing" | "none";

/** A problem row: a dot before the title in the trace error or wait color. */
export type DisclosureRowAttention = "error" | "warning";

export interface DisclosureRowProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  icon?: ReactNode;
  surface?: "selection" | "plain";
  /**
   * Where the open/closed cue sits. With trailing or none, a row with
   * nothing to reveal (no children, no count) is static: not a button, no
   * hover fill, not focusable, same alignment.
   */
  affordance?: DisclosureRowAffordance;
  /**
   * A muted count after the title: the direct child rows the caller shows
   * while the row is open, e.g. "턴 실행 (8)". A count above 0 makes a
   * trailing or no-chevron row interactive even without children.
   */
  count?: number;
  /** Problem rows only; the meta or title must still say what happened. */
  attention?: DisclosureRowAttention;
  /** A full-width line under the description (a SpanBar); it never indents with the text. */
  bar?: ReactNode;
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
  affordance = "leading",
  count,
  attention,
  bar,
  controlsId,
  open = false,
  onToggle,
  children,
  className,
  style,
  ...props
}: DisclosureRowProps) {
  const indent = useDisclosureRowIndent();
  const reduced = useReducedMotion();
  const leading = affordance === "leading";
  // Content: the panel (children) or child rows the caller shows on toggle (count).
  const interactive = leading || Boolean(children) || (count ?? 0) > 0;
  const shape = leading ? undefined : affordance;
  const triggerClass = cn(styles.trigger, !icon && styles.noIcon);
  const line = (
    <>
      {leading ? (
        <span className={styles.chevron} aria-hidden="true">
          {open ? <ChevronDown size="sm" /> : <ChevronRight size="sm" />}
        </span>
      ) : null}
      {icon ? <span className={styles.icon} data-slot="disclosure-row-icon">{icon}</span> : null}
      <RowTitle title={title} count={count} attention={attention} />
      {meta ? <Typo.Caption className={dsClass(styles.meta)} data-slot="disclosure-row-meta">{meta}</Typo.Caption> : null}
      {affordance === "trailing" && interactive ? (
        <span className={styles.turn} aria-hidden="true" data-open={open ? "true" : undefined}
          data-reduced={reduced ? "true" : undefined}>
          <ChevronRight size="sm" />
        </span>
      ) : null}
      {description || indent?.cue ? (
        <Typo.Caption className={dsClass(styles.description)}>
          {description}{description && indent?.cue ? " · " : null}{indent?.cue}
        </Typo.Caption>
      ) : null}
      {bar ? <span className={styles.barLine} data-slot="disclosure-row-bar">{bar}</span> : null}
    </>
  );
  return (
    <div
      className={cn(
        styles.root,
        open && interactive && styles.open,
        icon && styles.withIcon,
        surface === "plain" && styles.plain,
        className,
      )}
      data-surface={surface}
      data-affordance={shape}
      data-indent={indent ? "true" : undefined}
      style={indent ? dsStyle({ ...style, "--disclosure-indent-level": indent.level }) : style}
      {...props}
    >
      {interactive ? (
        <Clickable aria-controls={controlsId} className={dsClass(triggerClass)} aria-expanded={open} stretch onClick={onToggle}>
          {line}
        </Clickable>
      ) : (
        <div className={triggerClass} data-static="true">{line}</div>
      )}
      {children ? (
        <Collapsible open={open}>
          <div className={styles.panel} data-affordance={shape} data-icon={icon ? "true" : undefined}>
            <DisclosureRowIndentReset>{children}</DisclosureRowIndentReset>
          </div>
        </Collapsible>
      ) : null}
    </div>
  );
}

/** The title, with a problem dot before it and a muted count after it when given. */
function RowTitle({ title, count, attention }: Pick<DisclosureRowProps, "title" | "count" | "attention">) {
  if (count === undefined && !attention) {
    return <Typo.Body className={dsClass(styles.title)} data-slot="disclosure-row-title">{title}</Typo.Body>;
  }
  return (
    <span className={styles.titleLine}>
      {attention ? <span className={styles.dot} data-tone={attention} aria-hidden="true" /> : null}
      <Typo.Body as="span" className={dsClass(styles.title)} data-slot="disclosure-row-title">{title}</Typo.Body>
      {count !== undefined ? (
        <Typo.Caption tone="tertiary" numeric="tabular" className={dsClass(styles.count)}>{`(${count})`}</Typo.Caption>
      ) : null}
    </span>
  );
}
