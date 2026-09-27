"use client";

import type { DsBaseProps } from "../../lib/dsProps";
import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "../../lib/utils";
import styles from "../../components/Switch/Switch.module.css";

interface SwitchProps extends DsBaseProps<React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>> {
  size?: "default" | "sm";
}

function Switch({
  className,
  size = "default",
  ...props
}: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(styles.switch, className)}
      {...props}>
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={styles.thumb} />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
