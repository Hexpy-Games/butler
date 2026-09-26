import type { DsBaseProps } from "../../lib/dsProps";
import * as React from "react";

import { cn } from "../../lib/utils";
import styles from "../../components/Input/Input.module.css";

function Input({
  className,
  type,
  compact = false,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"input">> & {
  /** A short inline field (numbers in a toolbar): content width, small control height. */
  compact?: boolean;
}) {
  return (
    <input
      type={type}
      data-slot="input"
      data-compact={compact || undefined}
      className={cn(
        styles.input,
        className,
      )}
      {...props} />
  );
}

export { Input };
