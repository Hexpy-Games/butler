import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";
import styles from "./MarkdownContent.module.css";

export interface MarkdownContentProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function MarkdownContent({
  children,
  className,
  ...props
}: MarkdownContentProps) {
  return (
    <div className={cn(styles.markdown, className)} {...props}>
      {children}
    </div>
  );
}
