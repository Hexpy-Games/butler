import type { ReactNode } from "react";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { X } from "../../components/Icons";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import styles from "./SelectionBar.module.css";

export interface SelectionBarAction {
  id: string;
  /** A verb, a few words ("Add to chat"). Also the icon-only tooltip on narrow pages. */
  label: string;
  /** A 14px glyph. */
  icon: ReactNode;
  onSelect: () => void;
}

export interface SelectionBarProps extends DsPrivateStyleProps {
  /** Picked elements (1 or more). */
  count: number;
  /** The count in words ("2 selected"); also the toolbar's accessible name. */
  label: string;
  /** The full bar's actions in order; the compact pill keeps only the first. */
  actions: SelectionBarAction[];
  /** Picking is off but the selection stays on the tab: a small pill. */
  compact?: boolean;
  /** The picks are being dragged out of the page. */
  dimmed?: boolean;
  onClear: () => void;
  clearLabel: string;
  /** `floating` (default): bottom centre of the page area (PageCard `overlay`). `inline`: in flow. */
  placement?: "floating" | "inline";
}

/**
 * The picked-elements toolbar over the page (drawn in the overlay layer, so the live page never becomes
 * a still): a count, the actions and Clear, on one line at every width. On narrow page cards the actions
 * drop their words and keep their icons and tooltips.
 */
export function SelectionBar({
  count, label, actions, compact = false, dimmed = false, onClear, clearLabel, placement = "floating", className,
}: SelectionBarProps) {
  const shown = compact ? actions.slice(0, 1) : actions;
  return (
    <div className={cn(styles.bar, className)} role="toolbar" aria-label={label} data-slot="selection-bar"
      data-compact={compact || undefined} data-dimmed={dimmed || undefined} data-placement={placement}>
      <span className={styles.count} aria-hidden="true">{count > 99 ? "99+" : count}</span>
      <span className={styles.label}>{label}</span>
      {compact ? null : <span className={styles.separator} aria-hidden="true" />}
      <span className={styles.wide}>
        <ButtonContainer size="xs">
          {shown.map((action) => (
            <Button key={action.id} size="xs" variant="ghost" iconStart={action.icon} text={action.label} onClick={action.onSelect} />
          ))}
        </ButtonContainer>
      </span>
      <span className={styles.narrow}>
        <ButtonContainer size="icon-sm">
          {shown.map((action) => <IconButton key={action.id} label={action.label} onClick={action.onSelect}>{action.icon}</IconButton>)}
        </ButtonContainer>
      </span>
      {compact ? null : <span className={styles.separator} aria-hidden="true" />}
      <IconButton label={clearLabel} onClick={onClear}><X size="sm" /></IconButton>
    </div>
  );
}
