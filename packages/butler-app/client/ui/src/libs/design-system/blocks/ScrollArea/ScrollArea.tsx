import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { DsClassName, DsStyle } from "../../lib/internal";
import { windowDragClassName, type WindowDragProps } from "../../lib/windowDrag";
import type { ReactNode, Ref } from "react";
import { cn } from "../../lib/utils";
import { useComposedRefs } from "../../lib/composeRefs";
import { useScrollEdges, type ScrollEdgeAxis } from "../../lib/useScrollEdges";
import styles from "./ScrollArea.module.css";

export interface ScrollAreaProps extends DsPrivateStyleProps, WindowDragProps {
  children: ReactNode;
  /** DS-internal: class for the content wrapper. */
  contentClassName?: DsClassName;
  dataSlot?: string;
  dataTestClass?: string;
  fill?: boolean;
  /** DS-internal: style for the content wrapper. */
  contentStyle?: DsStyle;
  scrollRef?: Ref<HTMLDivElement>;
  /** Scrolling axis; the edge fade follows this axis. */
  orientation?: ScrollEdgeAxis;
  /** Horizontal pills rest on parent edges; fades extend outside them. */
  flush?: boolean;
  /** Cap the height; the area scrolls beyond it (`xs` 180px, `sm` 320px). */
  maxHeight?: "xs" | "sm";
  /** Keep at least this height even when the content is short (`xs` 96px, a chart legend). */
  minHeight?: "xs";
  /**
   * `inline-end`: extend into the container's inline-end padding (the
   * inspector gutter, `--inspector-inline-padding`) so the scrollbar sits in
   * the gutter while the content stays aligned with the column.
   */
  bleed?: "inline-end";
}

export function ScrollArea({
  children,
  className,
  contentClassName,
  dataSlot,
  dataTestClass,
  fill = false,
  style,
  contentStyle,
  scrollRef,
  orientation = "y",
  flush = false,
  maxHeight,
  minHeight,
  bleed,
  windowDrag,
}: ScrollAreaProps) {
  const edgesRef = useScrollEdges(orientation);
  const ref = useComposedRefs(scrollRef, edgesRef);
  return (
    <div
      className={cn(styles.frame, fill && styles.fill, windowDragClassName(windowDrag), className)}
      data-orientation={orientation}
      data-flush={orientation === "x" && flush ? "true" : undefined}
      data-max-height={maxHeight}
      data-min-height={minHeight}
      data-bleed={bleed}
      style={style}
    >
      <div
        ref={ref}
        className={styles.scroll}
        data-slot={dataSlot}
        data-test-class={dataTestClass}
      >
        <div
          className={cn(styles.content, contentClassName)}
          style={contentStyle}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
