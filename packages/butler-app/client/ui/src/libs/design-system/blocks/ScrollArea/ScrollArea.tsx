import type { CSSProperties, ReactNode, Ref } from "react";
import { cn } from "../../lib/utils";
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
}: ScrollAreaProps) {
  return (
    <div
      className={cn(styles.frame, fill && styles.fill, className)}
      style={style}
    >
      <div
        ref={scrollRef}
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
