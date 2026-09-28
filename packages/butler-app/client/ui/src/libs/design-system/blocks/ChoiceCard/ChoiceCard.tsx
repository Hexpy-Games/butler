import { Children, useId, type ButtonHTMLAttributes, type HTMLAttributes, type MouseEvent, type ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { cn } from "../../lib/utils";
import { AlertCircle, ChevronRight } from "../../components/Icons";
import { IconTile } from "../../components/IconTile";
import { Spinner } from "../../components/Spinner";
import { Typo } from "../../components/Typo";
import styles from "./ChoiceCard.module.css";

/** `loading` while the choice connects, `error` when it failed, `disabled` when it cannot be picked now. */
export type ChoiceCardState = "default" | "loading" | "error" | "disabled";

interface ChoiceBaseProps extends Omit<DsBaseProps<ButtonHTMLAttributes<HTMLButtonElement>>, "title" | "disabled"> {
  /** Glyph shown in the leading IconTile (a ProviderLogo or an icon). */
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  state?: ChoiceCardState;
  selected?: boolean;
}

export interface ChoiceCardProps extends ChoiceBaseProps {
  /** A short Tag after the title ("No key needed"). */
  tag?: ReactNode;
  /** Trailing text in place of the chevron (a size, a count). */
  meta?: ReactNode;
  /** Show the trailing chevron (default). Turn off for radio rows. */
  chevron?: boolean;
}

export interface ChoiceTileProps extends ChoiceBaseProps {
  /** Dashed, transparent tile for a choice that is not available yet. */
  placeholder?: boolean;
  /** Corner glyph for the tile's own action (a refresh mark). */
  cornerIcon?: ReactNode;
}

function guardedClick(state: ChoiceCardState, onClick: ChoiceBaseProps["onClick"]) {
  return (event: MouseEvent<HTMLButtonElement>) => {
    if (state === "disabled" || state === "loading") {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
}

function stateAttributes(state: ChoiceCardState, selected: boolean) {
  return {
    "aria-busy": state === "loading" ? true : undefined,
    "aria-disabled": state === "disabled" ? true : undefined,
    "data-selected": selected ? "true" : undefined,
    "data-state": state,
    type: "button" as const,
  };
}

/** A full-width choice row: leading logo tile, title with tag, one-line description, trailing chevron. */
export function ChoiceCard({
  icon, title, description, tag, meta, chevron = true, state = "default", selected = false, onClick, className, ...props
}: ChoiceCardProps) {
  const descriptionId = useId();
  const trailing = state === "loading" ? <Spinner size={14} />
    : state === "error" ? <AlertCircle size="md" />
      : meta ?? (chevron ? <ChevronRight size="md" /> : null);
  return (
    <button
      aria-describedby={description ? descriptionId : undefined}
      {...props}
      {...stateAttributes(state, selected)}
      className={cn(styles.card, className)}
      data-slot="choice-card"
      onClick={guardedClick(state, onClick)}
    >
      <IconTile size="md">{icon}</IconTile>
      <span className={styles.text}>
        <span className={styles.titleRow}>
          <Typo.Label as="span" truncate weight="semibold">{title}</Typo.Label>
          {tag}
        </span>
        {description ? <Typo.Caption className={dsClass(styles.description)} id={descriptionId} truncate>{description}</Typo.Caption> : null}
      </span>
      {trailing ? <span aria-hidden="true" className={styles.end}>{trailing}</span> : null}
    </button>
  );
}

/** A compact grid tile: logo, a name that wraps to two lines, a one-line description. */
export function ChoiceTile({
  icon, title, description, placeholder = false, cornerIcon, state = "default", selected = false, onClick, className, ...props
}: ChoiceTileProps) {
  const corner = state === "loading" ? <Spinner size={12} /> : cornerIcon;
  return (
    <button
      {...props}
      {...stateAttributes(state, selected)}
      className={cn(styles.tile, className)}
      data-corner={corner ? "true" : undefined}
      data-placeholder={placeholder ? "true" : undefined}
      data-slot="choice-tile"
      onClick={guardedClick(state, onClick)}
    >
      <IconTile className={dsClass(styles.tileIcon)} size="sm">{icon}</IconTile>
      <span className={styles.tileTitle}>
        <Typo.Label as="span" data-slot="choice-tile-title" lineClamp={2} weight="semibold">{title}</Typo.Label>
      </span>
      {description ? (
        <Typo.Caption className={dsClass(styles.tileDescription)} data-slot="choice-tile-description" truncate>{description}</Typo.Caption>
      ) : null}
      {corner ? <span aria-hidden="true" className={styles.corner}>{corner}</span> : null}
    </button>
  );
}

type ListProps = DsBaseProps<HTMLAttributes<HTMLUListElement>> & { children: ReactNode };

/** A vertical list of ChoiceCards (each child becomes a list item). */
export function ChoiceCardList({ children, className, ...props }: ListProps) {
  return (
    <ul {...props} className={cn(styles.list, className)} data-slot="choice-card-list">
      {Children.toArray(children).map((child, index) => <li className={styles.listItem} key={index}>{child}</li>)}
    </ul>
  );
}

/** Equal-size ChoiceTiles: two columns, three when the grid is at least 480px wide. */
export function ChoiceTileGrid({ children, className, ...props }: ListProps) {
  return (
    <div className={styles.gridFrame}>
      <ul {...props} className={cn(styles.grid, className)} data-slot="choice-tile-grid">
        {Children.toArray(children).map((child, index) => <li className={styles.gridItem} key={index}>{child}</li>)}
      </ul>
    </div>
  );
}
