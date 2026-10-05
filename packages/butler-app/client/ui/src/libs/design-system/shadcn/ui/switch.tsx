"use client";

import type { DsBaseProps } from "../../lib/dsProps";
import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { Tooltip } from "./tooltip";
import { cn } from "../../lib/utils";
import styles from "../../components/Switch/Switch.module.css";

interface SwitchProps extends DsBaseProps<React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>> {
  size?: "default" | "sm";
  /** Disables the switch and explains why on hover. */
  disabledReason?: string;
}

function Switch({
  className,
  size = "default",
  disabled,
  disabledReason,
  ...props
}: SwitchProps) {
  const control = (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(styles.switch, className)}
      {...props}
      disabled={Boolean(disabled || disabledReason)}>
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={styles.thumb} />
    </SwitchPrimitive.Root>
  );
  return disabledReason ? <Tooltip label={disabledReason}>{control}</Tooltip> : control;
}

export { Switch };
