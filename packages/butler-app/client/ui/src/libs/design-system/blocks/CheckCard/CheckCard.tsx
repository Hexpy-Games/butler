import { Children, useId, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { cn } from "../../lib/utils";
import { IconTile } from "../../components/IconTile";
import { Tooltip } from "../../components/Tooltip";
import { Typo } from "../../components/Typo";
// The card surface, border, radius, padding, hover, focus and selected look are ChoiceCard's own classes.
import surface from "../ChoiceCard/ChoiceCard.module.css";
import styles from "./CheckCard.module.css";

export interface CheckCardProps extends Omit<DsBaseProps<ButtonHTMLAttributes<HTMLButtonElement>>, "title" | "disabled" | "onChange" | "role"> {
  /** Optional glyph in the leading IconTile (a ProviderLogo or an icon). */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Cannot be picked right now (busy): dimmed, clicks ignored. */
  disabled?: boolean;
  /** Cannot be picked, with the reason in a tooltip; the card stays focusable so the reason can be read. */
  disabledReason?: string;
  /** Review variant: the round indicator at the end (default) or the start of the card. */
  indicatorSide?: "end" | "start";
  /** Review variant: a checked indicator shows a check (default) or is only filled. */
  checkedMark?: "check" | "fill";
}

/** CheckIcon's geometry (Hugeicons 24 grid), drawn as a stroke so it can draw in. */
const CHECK_PATH = "M5 14L8.5 17.5L19 6.5";

/**
 * The round check indicator: a ring on the card surface. Checked fills it with the accent from the centre
 * and draws the check; both stay mounted so a toggle mid-animation reverses cleanly.
 */
function Indicator({ checked, mark }: { checked: boolean; mark: "check" | "fill" }) {
  return (
    <span aria-hidden="true" className={styles.indicator} data-checked={checked ? "true" : undefined}>
      <span className={styles.fill} />
      {mark === "check" ? (
        <svg className={styles.mark} viewBox="0 0 24 24" fill="none" focusable="false">
          <path d={CHECK_PATH} pathLength={1} stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  );
}

/**
 * A card that is picked or not: several of them in a CheckCardList let people choose the items to act
 * on (import, include, bring over). The whole card is a `role="checkbox"`; click or Space toggles it.
 */
export function CheckCard({
  icon, title, description, checked, onCheckedChange, disabled = false, disabledReason,
  indicatorSide = "end", checkedMark = "check", className, onClick, ...props
}: CheckCardProps) {
  const descriptionId = useId();
  const blocked = disabled || Boolean(disabledReason);
  const indicator = <span className={styles.slot}><Indicator checked={checked} mark={checkedMark} /></span>;
  const card = (
    <button
      aria-describedby={description ? descriptionId : undefined}
      {...props}
      aria-checked={checked}
      aria-disabled={blocked ? true : undefined}
      className={cn(surface.card, styles.card, className)}
      data-icon={icon ? undefined : "none"}
      data-indicator={indicatorSide}
      data-selected={checked ? "true" : undefined}
      data-slot="check-card"
      data-state={blocked ? "disabled" : "default"}
      role="checkbox"
      type="button"
      onClick={(event) => {
        if (blocked) { event.preventDefault(); return; }
        onClick?.(event);
        onCheckedChange(!checked);
      }}
    >
      {indicatorSide === "start" ? indicator : null}
      {icon ? <IconTile className={dsClass(styles.tile)} size="md">{icon}</IconTile> : null}
      <span className={cn(surface.titleRow, styles.title)}>
        <Typo.Label as="span" truncate weight="semibold">{title}</Typo.Label>
      </span>
      {description ? (
        <Typo.Caption className={dsClass(cn(surface.description, styles.description))} id={descriptionId} truncate>{description}</Typo.Caption>
      ) : null}
      {indicatorSide === "end" ? indicator : null}
    </button>
  );
  return disabledReason ? <Tooltip label={disabledReason}>{card}</Tooltip> : card;
}

type ListProps = DsBaseProps<HTMLAttributes<HTMLUListElement>> & {
  children: ReactNode;
  /** The group's name for assistive tech, when no visible heading labels it (else pass aria-labelledby). */
  label?: string;
};

/** A labelled group of CheckCards (each child becomes a list item). */
export function CheckCardList({ children, className, label, ...props }: ListProps) {
  return (
    <ul aria-label={label} {...props} className={cn(surface.list, className)} data-slot="check-card-list" role="group">
      {Children.toArray(children).map((child, index) => <li className={surface.listItem} key={index}>{child}</li>)}
    </ul>
  );
}
