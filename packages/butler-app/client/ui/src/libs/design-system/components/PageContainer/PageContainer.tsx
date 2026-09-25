import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";
import styles from "./PageContainer.module.css";

export type PageContainerWidth = "narrow" | "default" | "full";
export type PageContainerGutter = "none" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl";

export interface PageContainerProps extends HTMLAttributes<HTMLElement> {
  children?: ReactNode;
  /** narrow: reading width (760px), default: wide page (72rem), full: no cap. */
  width?: PageContainerWidth;
  /** Inline padding; omit for the adaptive page gutter. */
  gutter?: PageContainerGutter;
  as?: "main" | "section" | "div";
}

/**
 * The page frame: centered, capped by page width tokens, and the `page`
 * inline-size container that Grid responsive columns and page layouts query.
 */
export function PageContainer({ as: Component = "div", width = "default", gutter, className, children, ...props }: PageContainerProps) {
  return (
    <Component
      className={cn(styles.page, className)}
      data-slot="page-container"
      data-width={width}
      data-gutter={gutter}
      {...props}
    >
      {children}
    </Component>
  );
}

export default PageContainer;
