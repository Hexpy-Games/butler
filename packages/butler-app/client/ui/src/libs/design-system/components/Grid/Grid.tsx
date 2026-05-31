import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Grid.module.css";

type GapToken =
  | "none" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl"
  | "1" | "2" | "3" | "4" | "5" | "6";
type ColumnPreset = "1" | "2" | "3" | "4" | "6" | "12" | "auto-fit" | "auto-fill";
type LayoutElement = "div" | "section" | "main" | "ul" | "ol";

export interface GridProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  as?: LayoutElement;
  columns?: ColumnPreset;
  gap?: GapToken;
}

export function Grid({
  as: Component = "div",
  children,
  columns = "auto-fit",
  gap = "md",
  className,
  ...props
}: GridProps) {
  const classes = [
    styles.grid,
    styles[`columns-${columns}`],
    styles[`gap-${gap}`],
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Component className={classes} {...props}>
      {children}
    </Component>
  );
}

export default Grid;
