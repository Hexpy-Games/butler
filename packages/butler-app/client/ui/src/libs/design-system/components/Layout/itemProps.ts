import styles from "./itemProps.module.css";

export type LayoutBasis = "auto" | "content" | "0" | "xs" | "sm" | "md" | "lg";
export type LayoutAlignSelf = "start" | "center" | "end" | "stretch" | "baseline";
export type LayoutSpan = "1" | "2" | "3" | "full";

/** How an element sits inside its Stack or Grid parent. */
export interface LayoutItemProps {
  /** Take the free space along the parent's main axis (flex-grow: 1). */
  grow?: boolean;
  /** `false` keeps the item from shrinking (flex-shrink: 0). */
  shrink?: boolean;
  /** Flex basis; named sizes use the `--layout-basis-*` tokens. */
  basis?: LayoutBasis;
  /** `"0"` lets a flex item shrink below its content (needed for truncation). */
  minWidth?: "0" | "auto";
  alignSelf?: LayoutAlignSelf;
  /** Grid children only: columns to span; `full` spans the whole row. */
  span?: LayoutSpan;
  /** Keep the item's space but hide it (visibility: hidden; out of the tab order and accessibility tree). */
  invisible?: boolean;
}

const ITEM_KEYS = ["grow", "shrink", "basis", "minWidth", "alignSelf", "span", "invisible"] as const;

/** Splits layout item props from the rest so they never reach the DOM as-is. */
export function splitLayoutItemProps<T extends LayoutItemProps>(
  props: T,
): [LayoutItemProps, Omit<T, keyof LayoutItemProps>] {
  const item: LayoutItemProps = {};
  const rest: Record<string, unknown> = { ...(props as Record<string, unknown>) };
  for (const key of ITEM_KEYS) {
    if (key in rest) {
      (item as Record<string, unknown>)[key] = rest[key];
      delete rest[key];
    }
  }
  return [item, rest as Omit<T, keyof LayoutItemProps>];
}

function hasItemProps(item: LayoutItemProps): boolean {
  return ITEM_KEYS.some((key) => item[key] !== undefined);
}

/** Class name and data attributes for layout item props (empty when none are set). */
export function layoutItemAttributes(item: LayoutItemProps): {
  className?: string;
  "data-grow"?: "true";
  "data-shrink"?: "true" | "false";
  "data-basis"?: LayoutBasis;
  "data-min-width"?: "0" | "auto";
  "data-align-self"?: LayoutAlignSelf;
  "data-span"?: LayoutSpan;
  "data-invisible"?: "true";
} {
  if (!hasItemProps(item)) return {};
  return {
    className: styles.item,
    "data-grow": item.grow ? "true" : undefined,
    "data-shrink": item.shrink === undefined ? undefined : item.shrink ? "true" : "false",
    "data-basis": item.basis,
    "data-min-width": item.minWidth,
    "data-align-self": item.alignSelf,
    "data-span": item.span,
    "data-invisible": item.invisible ? "true" : undefined,
  };
}
