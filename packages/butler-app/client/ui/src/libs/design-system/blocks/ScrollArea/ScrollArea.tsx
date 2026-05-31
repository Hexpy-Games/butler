import type { CSSProperties, ReactNode } from "react";
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
}: ScrollAreaProps) {
  return (
    <div
      className={cn(styles.frame, fill && styles.fill, className)}
      style={style}
    >
      <div
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
