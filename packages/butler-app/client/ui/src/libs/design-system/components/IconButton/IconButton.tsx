import type { DsBaseProps } from "../../lib/dsProps";
import React from "react";
import { Button } from "../Button";
import { Tooltip } from "../Tooltip";
import iconButtonStyles from "./IconButton.module.css";
import { dsClass } from "../../lib/internal";

void iconButtonStyles;

interface IconButtonProps extends DsBaseProps<React.ButtonHTMLAttributes<HTMLButtonElement>> {
  label: string;
  selected?: boolean;
  /**
   * `top-end`: shift the button so its icon (not its hit area) lines up with
   * the top-end corner of the row, e.g. card header actions beside a title.
   */
  opticalAlign?: "top-end";
}

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ children, className, label, selected, opticalAlign, onClick, disabled, ...props }, ref) {
  const button = (
    <Button
      ref={ref}
      className={dsClass(classNames(
        iconButtonStyles.moduleScope,
        "icon-button",
        selected && iconButtonStyles.selected,
        className,
      ))}
      variant="ghost"
      size="icon-sm"
      type="button"
      aria-label={label}
      data-optical-align={opticalAlign}
      onClick={onClick}
      disabled={disabled}
      title={undefined}
      {...props}
    >
      {children}
    </Button>
  );

  return props["aria-haspopup"] || props["aria-expanded"] !== undefined
    ? button
    : <Tooltip label={label}>{button}</Tooltip>;
});
