import type { DsBaseProps } from "../../lib/dsProps";
import * as React from "react";

import { cn } from "../../lib/utils";
import underline from "../../components/Input/UnderlineField.module.css";
import styles from "../../components/Input/Input.module.css";

function Input({
  className,
  type,
  compact = false,
  variant = "default",
  textSize = "inherit",
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"input">> & {
  /** A short inline field (numbers in a toolbar): content width, small control height. */
  compact?: boolean;
  /**
   * `underline`: bottom-border field for in-place entry, aligned with surrounding labels.
   * `quiet`: no border or fill at rest (a sidebar search), the row hover fill on hover and the
   * default field look while focused, so it never reads as a selected row.
   */
  variant?: "default" | "underline" | "quiet";
  /** Underline text metrics: inherit the surrounding text or match Typo.Label. */
  textSize?: "inherit" | "label";
}) {
  const input = (
    <input
      type={type}
      data-slot="input"
      data-variant={variant}
      data-text-size={textSize}
      data-compact={compact || undefined}
      className={cn(
        styles.input,
        variant === "underline" && underline.field,
        className,
      )}
      {...props} />
  );
  return variant === "underline"
    ? <span className={underline.inlineField} data-text-size={textSize}>{input}</span>
    : input;
}

export { Input };
