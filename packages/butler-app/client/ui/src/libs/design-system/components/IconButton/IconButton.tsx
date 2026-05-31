import React from "react";
import { Button } from "../Button";
import { Tooltip } from "../Tooltip";
import iconButtonStyles from "./IconButton.module.css";

void iconButtonStyles;

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  selected?: boolean;
}

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ children, className, label, selected, onClick, disabled, ...props }, ref) {
  const button = (
    <Button
      ref={ref}
      className={classNames(
        iconButtonStyles.moduleScope,
        "icon-button",
        selected && iconButtonStyles.selected,
        className,
      )}
      variant="ghost"
      size="icon-sm"
      type="button"
      aria-label={label}
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
