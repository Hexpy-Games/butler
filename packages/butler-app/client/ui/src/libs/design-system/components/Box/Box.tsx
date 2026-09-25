import type { HTMLAttributes, ReactNode } from "react";
import { layoutItemAttributes, splitLayoutItemProps, type LayoutItemProps } from "../Layout/itemProps";
import styles from "./Box.module.css";

export type BoxSpace = "none" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl";
export type BoxRadius = "none" | "control" | "panel" | "popover" | "pill";
export type BoxSurface = "none" | "base" | "raised" | "overlay" | "muted";
export type BoxBorder = "none" | "hairline" | "strong";
type BoxElement = "div" | "section" | "article" | "aside" | "header" | "footer" | "span" | "li";

/** A single surface: padding, radius, background and border from tokens. No tone. */
export interface BoxProps extends HTMLAttributes<HTMLElement>, LayoutItemProps {
  children?: ReactNode;
  as?: BoxElement;
  padding?: BoxSpace;
  paddingX?: BoxSpace;
  paddingY?: BoxSpace;
  radius?: BoxRadius;
  surface?: BoxSurface;
  border?: BoxBorder;
}

export function Box(allProps: BoxProps) {
  const [item, {
    as: Component = "div",
    children,
    padding,
    paddingX,
    paddingY,
    radius,
    surface,
    border,
    className,
    ...props
  }] = splitLayoutItemProps(allProps);
  const { className: itemClassName, ...itemAttributes } = layoutItemAttributes(item);
  return (
    <Component
      className={[styles.box, itemClassName, className].filter(Boolean).join(" ")}
      data-padding={padding}
      data-padding-x={paddingX}
      data-padding-y={paddingY}
      data-radius={radius}
      data-surface={surface}
      data-border={border}
      {...itemAttributes}
      {...props}
    >
      {children}
    </Component>
  );
}

export default Box;
