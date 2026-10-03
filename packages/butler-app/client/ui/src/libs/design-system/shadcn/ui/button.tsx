import type { DsBaseProps } from "../../lib/dsProps";
import * as React from "react";
import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import { Slot } from "@radix-ui/react-slot";
import styles from "../../components/Button/Button.module.css";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  styles.button,
  {
    variants: {
      variant: {
        default: styles.variantDefault,
        outline: styles.variantOutline,
        borderless: styles.variantBorderless,
        inline: styles.variantInline,
        secondary: styles.variantSecondary,
        ghost: styles.variantGhost,
        destructive: styles.variantDestructive,
        link: styles.variantLink,
      },
      size: {
        default: "",
        xs: styles.sizeXs,
        sm: styles.sizeSm,
        lg: styles.sizeLg,
        icon: styles.sizeIcon,
        "icon-xs": styles.sizeIconXs,
        "icon-sm": styles.sizeIconSm,
        "icon-lg": styles.sizeIconLg,
      },
      shape: {
        default: "",
        pill: styles.shapePill,
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      shape: "default",
    },
  },
);

interface ButtonProps
  extends VariantProps<typeof buttonVariants>, DsBaseProps<React.ButtonHTMLAttributes<HTMLButtonElement>> {
  asChild?: boolean;
  iconStart?: React.ReactNode;
  iconEnd?: React.ReactNode;
  text?: React.ReactNode;
  stretch?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  children,
  className,
  variant = "default",
  size = "default",
  shape = "default",
  asChild = false,
  iconStart,
  iconEnd,
  text,
  stretch = false,
  onClick,
  ...props
}, ref) {
  const Comp = asChild ? Slot : "button";
  const hasStructuredContent =
    !asChild && (iconStart != null || iconEnd != null || text != null);
  const textContent = text ?? children;
  const hasIconText =
    hasStructuredContent &&
    textContent != null &&
    (iconStart != null || iconEnd != null);
  const iconLayout =
    hasIconText && iconStart != null && iconEnd == null
      ? "start"
      : hasIconText && iconStart == null && iconEnd != null
        ? "end"
        : hasIconText && iconStart != null && iconEnd != null
          ? "both"
          : undefined;

  return (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-shape={shape}
      data-stretch={stretch ? "true" : undefined}
      data-has-icon-text={hasIconText ? "true" : undefined}
      data-icon-layout={iconLayout}
      className={cn(buttonVariants({ variant, size, shape, className }))}
      {...props}
      onClick={(event) => {
        if (props["aria-disabled"] === true || props["aria-disabled"] === "true") {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClick?.(event);
      }}
    >
      {hasStructuredContent ? (
        <>
          {iconStart ? (
            <span
              aria-hidden="true"
              className={styles.icon}
              data-position="start"
              data-slot="button-icon"
            >
              {iconStart}
            </span>
          ) : null}
          {textContent != null ? (
            <span className={styles.text} data-slot="button-text">
              {textContent}
            </span>
          ) : null}
          {iconEnd ? (
            <span
              aria-hidden="true"
              className={styles.icon}
              data-position="end"
              data-slot="button-icon"
            >
              {iconEnd}
            </span>
          ) : null}
        </>
      ) : (
        children
      )}
    </Comp>
  );
});

export { Button, buttonVariants };
