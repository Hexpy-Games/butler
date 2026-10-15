import type { ReactNode } from "react";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { Pick, X } from "../../components/Icons";
import { Tooltip } from "../../components/Tooltip";
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
  /** Shown but unavailable: the reason is its tooltip ("Pick an element first"). */
  disabledReason?: string;
}

export interface SelectionBarProps extends DsPrivateStyleProps {
  /** Picked elements. 0 is the picking state before the first pick (the full bar only). */
  count: number;
  /** The count in words ("2 selected"); also the toolbar's accessible name. */
  label: string;
  /** At 0: what to do ("Click elements to pick them"), in place of the count label and as the toolbar's name. */
  hint?: string;
  /** At 0: why the actions are unavailable ("Pick an element first"); every action shows it as its tooltip. */
  emptyReason?: string;
  /** The full bar's actions in order; the compact pill keeps only the first. */
  actions: SelectionBarAction[];
  /** Picking is off but the selection stays on the tab: a small pill (nothing at 0). */
  compact?: boolean;
  /** The picks are being dragged out of the page. */
  dimmed?: boolean;
  /** Clears the picks; hidden at 0. */
  onClear: () => void;
  clearLabel: string;
  /** `floating` (default): bottom centre of the page area (PageCard `overlay`). `inline`: in flow. */
  placement?: "floating" | "inline";
}

function WideAction({ action, reason }: { action: SelectionBarAction; reason?: string }) {
  if (!reason) return <Button size="xs" variant="ghost" iconStart={action.icon} text={action.label} onClick={action.onSelect} />;
  return <Tooltip label={reason}><Button size="xs" variant="ghost" iconStart={action.icon} text={action.label} aria-disabled="true" /></Tooltip>;
}

function NarrowAction({ action, reason }: { action: SelectionBarAction; reason?: string }) {
  if (!reason) return <IconButton label={action.label} onClick={action.onSelect}>{action.icon}</IconButton>;
  return <IconButton label={`${action.label} · ${reason}`} aria-disabled="true">{action.icon}</IconButton>;
}

/**
 * The picked-elements toolbar over the page (drawn in the overlay layer, so the live page never becomes
 * a still): a count, the actions and Clear, on one line at every width. From the moment pick mode starts
 * it shows at 0 with a hint and unavailable actions. With less than 620px of room the actions drop their
 * words and keep their icons and tooltips; below 340px the count label (or hint) drops too.
 */
export function SelectionBar({
  count, label, hint, emptyReason, actions, compact = false, dimmed = false, onClear, clearLabel, placement = "floating", className,
}: SelectionBarProps) {
  const empty = count <= 0;
  if (empty && compact) return null;
  const shown = compact ? actions.slice(0, 1) : actions;
  const reason = (action: SelectionBarAction) => action.disabledReason ?? (empty ? emptyReason ?? hint ?? label : undefined);
  const name = empty ? hint ?? label : label;
  return (
    <div className={cn(styles.host, className)} data-placement={placement} data-slot="selection-bar-host">
      <div className={styles.bar} role="toolbar" aria-label={name} data-slot="selection-bar" data-empty={empty || undefined}
        data-compact={compact || undefined} data-dimmed={dimmed || undefined}>
        <span className={styles.count} aria-hidden="true">{empty ? <Pick size="sm" /> : count > 99 ? "99+" : count}</span>
        <span className={styles.label} data-slot="selection-bar-label">{name}</span>
        {compact ? null : <span className={styles.separator} aria-hidden="true" />}
        <span className={styles.wide}>
          <ButtonContainer size="xs">{shown.map((action) => <WideAction key={action.id} action={action} reason={reason(action)} />)}</ButtonContainer>
        </span>
        <span className={styles.narrow}>
          <ButtonContainer size="icon-sm">{shown.map((action) => <NarrowAction key={action.id} action={action} reason={reason(action)} />)}</ButtonContainer>
        </span>
        {compact || empty ? null : <span className={styles.separator} aria-hidden="true" />}
        {empty ? null : <IconButton label={clearLabel} onClick={onClear}><X size="sm" /></IconButton>}
      </div>
    </div>
  );
}
