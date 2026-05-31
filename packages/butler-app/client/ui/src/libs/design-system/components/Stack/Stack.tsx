import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Stack.module.css";

type GapToken =
  | "none"
  | "xs"
  | "sm"
  | "md"
  | "lg"
  | "xl"
  | "2xl"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6";
type JustifyAlign =
  | "start"
  | "center"
  | "end"
  | "between"
  | "around"
  | "evenly";
type CrossAlign = "start" | "center" | "end" | "stretch" | "baseline";
type LayoutElement =
  | "div"
  | "section"
  | "header"
  | "main"
  | "nav"
  | "aside"
  | "article"
  | "footer"
  | "span"
  | "ul"
  | "ol";

export interface StackProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  as?: LayoutElement;
  align?: "row" | "column";
  gap?: GapToken;
  justify?: JustifyAlign;
  cross?: CrossAlign;
  fill?: boolean;
  wrap?: boolean;
}

export function Stack({
  as: Component = "div",
  children,
  align = "column",
  gap = "md",
  justify = "start",
  cross = "stretch",
  fill = false,
  wrap = false,
  className,
  ...props
}: StackProps) {
  const classes = [
    styles.stack,
    styles[`align-${align}`],
    styles[`gap-${gap}`],
    styles[`justify-${justify}`],
    styles[`cross-${cross}`],
    fill && styles.fill,
    wrap && styles.wrap,
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

export default Stack;
