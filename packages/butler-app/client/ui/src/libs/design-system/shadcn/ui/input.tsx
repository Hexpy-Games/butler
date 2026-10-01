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
  /** Bottom-border field for in-place entry, aligned with surrounding labels. */
  variant?: "default" | "underline";
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
