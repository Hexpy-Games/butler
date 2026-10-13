import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { cn } from "../../lib/utils";
import { CheckIcon } from "../../components/Icons";
import { IconTile } from "../../components/IconTile";
import { Tooltip } from "../../components/Tooltip";
import { Typo } from "../../components/Typo";
import styles from "./ChoiceCard.module.css";

export interface ChoiceCheckCardProps extends Omit<DsBaseProps<ButtonHTMLAttributes<HTMLButtonElement>>, "title" | "disabled" | "onChange" | "role"> {
  /** Glyph shown in the leading IconTile (a ProviderLogo or an icon). */
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Cannot be picked now (busy): dimmed, clicks ignored. */
  disabled?: boolean;
  /** Cannot be picked, with the reason in a tooltip; the card stays focusable so the reason can be read. */
  disabledReason?: string;
}

/** The square check box at the end of a ChoiceCheckCard. */
function CheckBox({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden="true" className={styles.checkBox} data-checked={checked ? "true" : undefined}>
      {checked ? <CheckIcon size="sm" /> : null}
    </span>
  );
}

/**
 * A multi-select ChoiceCard: the same card surface with a check box at the end instead of a chevron. The
 * whole card is a `role="checkbox"`; put several in a `ChoiceCardList role="group"` labelled by its heading.
 */
export function ChoiceCheckCard({
  icon, title, description, checked, onCheckedChange, disabled = false, disabledReason, className, onClick, ...props
}: ChoiceCheckCardProps) {
  const descriptionId = useId();
  const blocked = disabled || Boolean(disabledReason);
  const card = (
    <button
      aria-describedby={description ? descriptionId : undefined}
      {...props}
      aria-checked={checked}
      aria-disabled={blocked ? true : undefined}
      className={cn(styles.card, className)}
      data-selected={checked ? "true" : undefined}
      data-slot="choice-check-card"
      data-state={blocked ? "disabled" : "default"}
      role="checkbox"
      type="button"
      onClick={(event) => {
        if (blocked) { event.preventDefault(); return; }
        onClick?.(event);
        onCheckedChange(!checked);
      }}
    >
      <IconTile size="md">{icon}</IconTile>
      <span className={styles.text}>
        <span className={styles.titleRow}>
          <Typo.Label as="span" truncate weight="semibold">{title}</Typo.Label>
        </span>
        {description ? <Typo.Caption className={dsClass(styles.description)} id={descriptionId} truncate>{description}</Typo.Caption> : null}
      </span>
      <span className={styles.end}><CheckBox checked={checked} /></span>
    </button>
  );
  return disabledReason ? <Tooltip label={disabledReason}>{card}</Tooltip> : card;
}
