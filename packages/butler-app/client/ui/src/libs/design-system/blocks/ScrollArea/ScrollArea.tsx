import type { CSSProperties, ReactNode, Ref } from "react";
import { cn } from "../../lib/utils";
import { useComposedRefs } from "../../lib/composeRefs";
import { useScrollEdges, type ScrollEdgeAxis } from "../../lib/useScrollEdges";
import styles from "./ScrollArea.module.css";

export interface ScrollAreaProps {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  dataSlot?: string;
  dataTestClass?: string;
  fill?: boolean;
  style?: CSSProperties;
  contentStyle?: CSSProperties;
  scrollRef?: Ref<HTMLDivElement>;
  /** Scrolling axis; the edge fade follows this axis. */
  orientation?: ScrollEdgeAxis;
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
}: ScrollAreaProps) {
  const edgesRef = useScrollEdges(orientation);
  const ref = useComposedRefs(scrollRef, edgesRef);
  return (
    <div
      className={cn(styles.frame, fill && styles.fill, className)}
      data-orientation={orientation}
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
