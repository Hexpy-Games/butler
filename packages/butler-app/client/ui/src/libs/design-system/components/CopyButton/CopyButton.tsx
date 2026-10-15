import { Copy } from "../Icons";
import { DONE_FEEDBACK_MS, DoneIconButton } from "../DoneIconButton";

/** How long the check stays before the copy icon returns. */
export const COPY_FEEDBACK_MS = DONE_FEEDBACK_MS;

export interface CopyButtonProps {
  /** Label (tooltip and accessible name) before copying. */
  label: string;
  /** Label and live announcement after a successful copy. */
  copiedLabel: string;
  /** Text to copy, or a function that returns it at click time. */
  text?: string | (() => string);
  /** Parent-driven copy: called instead of writing `text` to the clipboard. */
  onCopy?: () => void;
  /** Parent-driven copied state; overrides the internal feedback state. */
  copied?: boolean;
  onError?: (error: unknown) => void;
  "aria-label"?: string;
}

/** DoneIconButton's copy action: writes `text` to the clipboard, then the shared icon -> check morph. */
export function CopyButton({ label, copiedLabel, text, onCopy, copied, onError, "aria-label": ariaLabel }: CopyButtonProps) {
  return (
    <DoneIconButton
      label={label}
      doneLabel={copiedLabel}
      aria-label={ariaLabel}
      icon={<Copy size="sm" />}
      // A parent-driven copy shows only the parent's copied state.
      done={copied ?? (onCopy ? false : undefined)}
      onAction={onCopy ? () => { onCopy(); } : () => navigator.clipboard.writeText(typeof text === "function" ? text() : text ?? "")}
      onError={onError}
    />
  );
}
