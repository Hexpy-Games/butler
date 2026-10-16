import type { ButtonHTMLAttributes } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { SendHorizontal, Square } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import { Tooltip, type TooltipAlign, type TooltipSide } from "../../components/Tooltip";
import { cn } from "../../lib/utils";
import styles from "./ComposerCard.module.css";

export interface ComposerSendButtonProps
 extends DsBaseProps<ButtonHTMLAttributes<HTMLButtonElement>> {
  mode?: "send" | "stop";
  busy?: boolean;
  /**
   * Blocks sending and names why in a short tooltip (a few words, no
   * explanation). The button stays hoverable so the tooltip opens.
   */
  disabledReason?: string;
  /** Side the disabledReason tooltip opens on (default `top`). */
  disabledReasonSide?: TooltipSide;
  /** Alignment of the disabledReason tooltip along that side (default `center`). */
  disabledReasonAlign?: TooltipAlign;
}

export function ComposerSendButton({
  mode = "send",
  busy = false,
  disabled,
  disabledReason,
  disabledReasonSide = "top",
  disabledReasonAlign = "center",
  className,
  children,
  onClick,
  ...props
}: ComposerSendButtonProps) {
  const blocked = Boolean(disabledReason) && !busy;
  const button = (
    <button
      className={cn(styles.sendButton, mode === "stop" && styles.stop, className)}
      data-test-class="composer-send-button"
      type={!busy && !blocked && mode === "send" ? "submit" : "button"}
      onClick={blocked ? (event) => event.preventDefault() : onClick}
      {...props}
      disabled={busy || (disabled && !blocked)}
      aria-disabled={blocked ? "true" : undefined}
      aria-busy={busy || undefined}
    >
      {busy ? <Spinner size={16} /> : children ?? (mode === "stop" ? <Square size="sm" /> : <SendHorizontal size="md" />)}
    </button>
  );
  return blocked
    ? <Tooltip label={disabledReason} side={disabledReasonSide} align={disabledReasonAlign}>{button}</Tooltip>
    : button;
}
