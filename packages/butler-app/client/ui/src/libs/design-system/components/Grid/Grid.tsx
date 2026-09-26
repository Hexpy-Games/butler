import type { DsBaseProps } from "../../lib/dsProps";
import type { HTMLAttributes, ReactNode, Ref } from "react";
import { layoutItemAttributes, splitLayoutItemProps, type LayoutItemProps } from "../Layout/itemProps";
import styles from "./Grid.module.css";

/** Named spacing only; the numeric aliases "1".."6" were removed. */
type GapToken = "none" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl";
/** `label-value`: a label column (min 7rem, 28%) and a value column, baseline-aligned. */
export type GridColumnPreset = "1" | "2" | "3" | "4" | "6" | "12" | "auto-fit" | "auto-fill" | "main-aside" | "label-value";
/**
 * Responsive columns keyed to the enclosing PageContainer: `base` always
 * applies, `wide` from `@container page (min-width: 48rem)`.
 */
export interface GridResponsiveColumns {
  base: GridColumnPreset;
  wide?: GridColumnPreset;
}
type LayoutElement = "div" | "section" | "main" | "ul" | "ol" | "li" | "article";

export interface GridProps extends DsBaseProps<HTMLAttributes<HTMLElement>> {
  children: ReactNode;
  as?: LayoutElement;
  columns?: GridColumnPreset | GridResponsiveColumns;
  gap?: GapToken;
  /** DOM ref (e.g. a scroll-edge observer on a scrolling grid). */
  ref?: Ref<HTMLElement>;
}

function GridRoot({
  as: Component = "div",
  children,
  columns = "auto-fit",
  gap = "md",
  className,
  ref,
  ...props
}: GridProps) {
  const responsive = typeof columns === "object";
  const base = responsive ? columns.base : columns;
  const classes = [
    styles.grid,
    responsive ? styles.responsive : styles[`columns-${base}`],
    styles[`gap-${gap}`],
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Component
      className={classes}
      data-columns={base}
      data-columns-wide={responsive ? columns.wide : undefined}
      {...props}
      // One ref type for every element the grid can render as.
      ref={ref as Ref<HTMLDivElement & HTMLUListElement & HTMLOListElement & HTMLLIElement>}
    >
      {children}
    </Component>
  );
}

export interface GridItemProps extends LayoutItemProps, DsBaseProps<HTMLAttributes<HTMLElement>> {
  children?: ReactNode;
  as?: LayoutElement;
}

/** A Grid cell with item props such as `span`, instead of a styled wrapper div. */
function GridItem(allProps: GridItemProps) {
  const [item, { as: Component = "div", className, children, ...props }] = splitLayoutItemProps(allProps);
  const { className: itemClassName, ...itemAttributes } = layoutItemAttributes(item);
  const classes = [itemClassName, className].filter(Boolean).join(" ");
  return (
    <Component className={classes || undefined} {...itemAttributes} {...props}>
      {children}
    </Component>
  );
}

export const Grid = Object.assign(GridRoot, { Item: GridItem });

export default Grid;
