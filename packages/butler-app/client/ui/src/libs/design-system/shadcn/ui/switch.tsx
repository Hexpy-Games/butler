"use client";

import type { DsBaseProps } from "../../lib/dsProps";
import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { Tooltip, type TooltipAlign, type TooltipSide } from "./tooltip";
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
  /**
   * Side the disabledReason tooltip opens on. Default `right`: a switch sits
   * under its label and description (SettingsField) or after them in a row,
   * so its right side is where the tooltip covers neither.
   */
  disabledReasonSide?: TooltipSide;
  /** Alignment of the disabledReason tooltip along that side (default `center`). */
  disabledReasonAlign?: TooltipAlign;
}

function Switch({
  className,
  size = "default",
  disabled,
  disabledReason,
  disabledReasonSide = "right",
  disabledReasonAlign = "center",
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
  return blocked ? (
    <Tooltip label={disabledReason} side={disabledReasonSide} align={disabledReasonAlign}>{control}</Tooltip>
  ) : control;
}

export { Switch };
