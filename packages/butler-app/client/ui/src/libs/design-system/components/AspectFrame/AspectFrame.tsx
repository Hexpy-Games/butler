import type { HTMLAttributes, ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import type { IconSize } from "../Icons";
import styles from "./AspectFrame.module.css";

export interface AspectFrameProps extends DsBaseProps<HTMLAttributes<HTMLSpanElement>> {
  /** A canvas, image or video that fills the frame. */
  children: ReactNode;
  /** Fixed square size from `--icon-size-*`; omit to fill the container width. */
  size?: IconSize;
}

/**
 * A square, paint-contained frame for a canvas or media element (animated
 * marks). The child fills the frame; the frame never grows past its container.
 */
export function AspectFrame({ children, size, className, ...props }: AspectFrameProps) {
  return (
    <span className={cn(styles.frame, className)} data-slot="aspect-frame" data-size={size} {...props}>
      {children}
    </span>
  );
}
