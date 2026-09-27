import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { DsBaseProps } from "../../lib/dsProps";
import styles from "./Button.module.css";

export type ButtonVariant = "default" | "outline" | "borderless" | "inline" | "secondary" | "ghost" | "destructive" | "link";
export type ButtonSize = "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";

const VARIANT: Record<ButtonVariant, string | undefined> = {
  default: styles.variantDefault,
  outline: styles.variantOutline,
  borderless: styles.variantBorderless,
  inline: styles.variantInline,
  secondary: styles.variantSecondary,
  ghost: styles.variantGhost,
  destructive: styles.variantDestructive,
  link: styles.variantLink,
};

const SIZE: Record<ButtonSize, string | undefined> = {
  default: undefined,
  xs: styles.sizeXs,
  sm: styles.sizeSm,
  lg: styles.sizeLg,
  icon: styles.sizeIcon,
  "icon-xs": styles.sizeIconXs,
  "icon-sm": styles.sizeIconSm,
  "icon-lg": styles.sizeIconLg,
};

interface ButtonOwnProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: "default" | "pill";
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
  text?: ReactNode;
  children?: ReactNode;
  stretch?: boolean;
}

type ButtonElementProps = DsBaseProps<ButtonHTMLAttributes<HTMLButtonElement>> & { href?: undefined };
type LinkElementProps = DsBaseProps<AnchorHTMLAttributes<HTMLAnchorElement>> & { href: string };

/** A button, or a link styled as one when `href` is given. */
export type ButtonProps = ButtonOwnProps & (ButtonElementProps | LinkElementProps);

export function Button({
  variant = "default",
  size = "default",
  shape = "default",
  iconStart,
  iconEnd,
  text,
  children,
  stretch = false,
  ...props
}: ButtonProps) {
  const label = text ?? children;
  const structured = iconStart != null || iconEnd != null || text != null;
  const hasIconText = structured && label != null && (iconStart != null || iconEnd != null);
  const iconLayout = !hasIconText ? undefined : iconStart != null && iconEnd != null ? "both" : iconStart != null ? "start" : "end";
  const shared = {
    className: cn(styles.button, VARIANT[variant], SIZE[size], shape === "pill" && styles.shapePill),
    "data-slot": "button",
    "data-variant": variant,
    "data-size": size,
    "data-stretch": stretch ? "true" : undefined,
    "data-has-icon-text": hasIconText ? "true" : undefined,
    "data-icon-layout": iconLayout,
  };
  const content = structured ? (
    <>
      {iconStart ? <span aria-hidden="true" className={styles.icon} data-position="start">{iconStart}</span> : null}
      {label != null ? <span className={styles.text}>{label}</span> : null}
      {iconEnd ? <span aria-hidden="true" className={styles.icon} data-position="end">{iconEnd}</span> : null}
    </>
  ) : children;

  if (props.href !== undefined) {
    return <a {...shared} {...(props as LinkElementProps)}>{content}</a>;
  }
  return <button type="button" {...shared} {...(props as ButtonElementProps)}>{content}</button>;
}
