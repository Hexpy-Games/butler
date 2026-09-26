import { withUnsafeStyle, type DsBaseProps, type UnsafeStyleProps } from "../../lib/dsProps";
import { windowDragClassName, type WindowDragProps } from "../../lib/windowDrag";
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

export interface StackProps
  extends Omit<LayoutItemProps, "span">, DsBaseProps<HTMLAttributes<HTMLElement>>, WindowDragProps, UnsafeStyleProps {
  children: ReactNode;
  as?: LayoutElement;
  align?: "row" | "column";
  gap?: StackGap;
  /** Gap between wrapped lines when it differs from `gap` (which then only spaces items in a line). */
  rowGap?: StackGap;
  /** Gap on phone widths (640px and below) when it differs from `gap`. */
  compactGap?: StackGap;
  justify?: JustifyAlign;
  cross?: CrossAlign;
  fill?: boolean;
  wrap?: boolean;
  /** Lay out inline (`inline-flex`), e.g. a run of text and icons inside a line. */
  inline?: boolean;
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
    compactGap,
    justify = "start",
    cross = "stretch",
    fill = false,
    wrap = false,
    inline = false,
    windowDrag,
    className,
    style,
    UNSAFE_style,
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
    inline && styles.inline,
    windowDragClassName(windowDrag),
    itemClassName,
    className,
  );

  return (
    <Component className={classes} data-row-gap={rowGap} data-compact-gap={compactGap} style={withUnsafeStyle(style, UNSAFE_style)}
      {...itemAttributes} {...props}>
      {children}
    </Component>
  );
}

export interface StackItemProps extends Omit<LayoutItemProps, "span">, DsBaseProps<HTMLAttributes<HTMLElement>> {
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
