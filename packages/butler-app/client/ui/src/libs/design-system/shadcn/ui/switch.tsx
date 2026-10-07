"use client";

import type { DsBaseProps } from "../../lib/dsProps";
import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { Tooltip } from "./tooltip";
import { cn } from "../../lib/utils";
import styles from "../../components/Switch/Switch.module.css";

interface SwitchProps extends DsBaseProps<React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>> {
  size?: "default" | "sm";
  /**
   * Blocks the switch and names why in a short tooltip (a few words). It
   * stays focusable and hoverable (aria-disabled) so the reason can be read;
   * it wins over `disabled`.
   */
  disabledReason?: string;
}

function Switch({
  className,
  size = "default",
  disabled,
  disabledReason,
  onClick,
  ...props
}: SwitchProps) {
  const blocked = Boolean(disabledReason);
  const control = (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(styles.switch, className)}
      {...props}
      // Radix skips its toggle when the click is default-prevented.
      onClick={blocked ? (event) => event.preventDefault() : onClick}
      disabled={disabled && !blocked}
      aria-disabled={blocked ? true : props["aria-disabled"]}>
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={styles.thumb} />
    </SwitchPrimitive.Root>
  );
  return blocked ? <Tooltip label={disabledReason}>{control}</Tooltip> : control;
}

export { Switch };
