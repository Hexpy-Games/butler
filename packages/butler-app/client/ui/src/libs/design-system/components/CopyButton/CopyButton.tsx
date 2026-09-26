import { useEffect, useRef, useState } from "react";
import { IconButton } from "../IconButton";
import { CheckIcon, Copy } from "../Icons";
import styles from "./CopyButton.module.css";
import { dsClass } from "../../lib/internal";

/** How long the check stays before the copy icon returns. */
export const COPY_FEEDBACK_MS = 1500;

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

export function CopyButton({
  label,
  copiedLabel,
  text,
  onCopy,
  copied: copiedProp,
  onError,
  "aria-label": ariaLabel,
}: CopyButtonProps) {
  const [copiedState, setCopiedState] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copied = copiedProp ?? copiedState;

  const copy = async () => {
    if (onCopy) {
      onCopy();
      return;
    }
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text ?? "");
      setCopiedState(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopiedState(false), COPY_FEEDBACK_MS);
    } catch (error) {
      onError?.(error);
    }
  };

  return (
    <>
      <IconButton
        className={dsClass(styles.button)}
        data-copied={copied ? "true" : "false"}
        label={copied ? copiedLabel : label}
        aria-label={copied ? copiedLabel : ariaLabel ?? label}
        onClick={() => void copy()}
      >
        <span className={styles.icons} aria-hidden="true">
          <Copy size="sm" className={dsClass(styles.icon, styles.copyIcon)} />
          <CheckIcon size="sm" className={dsClass(styles.icon, styles.checkIcon)} />
        </span>
      </IconButton>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? copiedLabel : ""}
      </span>
    </>
  );
}
