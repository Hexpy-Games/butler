import type { HTMLAttributes, ReactNode } from "react";
import { layoutItemAttributes, splitLayoutItemProps, type LayoutItemProps } from "../Layout/itemProps";
import styles from "./Stack.module.css";

/** Named spacing only; the numeric aliases "1".."6" were removed. */
export type StackGap = "none" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl";
type JustifyAlign =
  | "start"
  | "center"
  | "end"
  | "between"
  | "around"
  | "evenly";
type CrossAlign = "start" | "center" | "end" | "stretch" | "baseline";
export type LayoutElement =
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
  | "ol"
  | "li";

export interface StackProps extends HTMLAttributes<HTMLElement>, Omit<LayoutItemProps, "span"> {
  children: ReactNode;
  as?: LayoutElement;
  align?: "row" | "column";
  gap?: StackGap;
  /** Gap between wrapped lines when it differs from `gap` (which then only spaces items in a line). */
  rowGap?: StackGap;
  justify?: JustifyAlign;
  cross?: CrossAlign;
  fill?: boolean;
  wrap?: boolean;
}

function join(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function StackRoot(allProps: StackProps) {
  const [item, {
    as: Component = "div",
    children,
    align = "column",
    gap = "md",
    rowGap,
    justify = "start",
    cross = "stretch",
    fill = false,
    wrap = false,
    className,
    ...props
  }] = splitLayoutItemProps(allProps);
  const { className: itemClassName, ...itemAttributes } = layoutItemAttributes(item);
  const classes = join(
    styles.stack,
    styles[`align-${align}`],
    styles[`gap-${gap}`],
    styles[`justify-${justify}`],
    styles[`cross-${cross}`],
    fill && styles.fill,
    wrap && styles.wrap,
    itemClassName,
    className,
  );

  return (
    <Component className={classes} data-row-gap={rowGap} {...itemAttributes} {...props}>
      {children}
    </Component>
  );
}

export interface StackItemProps extends HTMLAttributes<HTMLElement>, Omit<LayoutItemProps, "span"> {
  children?: ReactNode;
  as?: LayoutElement;
}

/** Wraps one child of a Stack with item props instead of a styled wrapper div. */
function StackItem(allProps: StackItemProps) {
  const [item, { as: Component = "div", className, children, ...props }] = splitLayoutItemProps(allProps);
  const { className: itemClassName, ...itemAttributes } = layoutItemAttributes(item);
  return (
    <Component className={join(itemClassName, className) || undefined} {...itemAttributes} {...props}>
      {children}
    </Component>
  );
}

export const Stack = Object.assign(StackRoot, { Item: StackItem });

export default Stack;
