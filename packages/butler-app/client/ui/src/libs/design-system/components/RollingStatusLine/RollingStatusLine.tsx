import type { HTMLAttributes, ReactNode } from "react";
import styles from "./RollingStatusLine.module.css";

export interface RollingStatusLineProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export function RollingStatusLine({
  children,
  className,
  ...props
}: RollingStatusLineProps) {
  return (
    <div className={[styles.slot, className].filter(Boolean).join(" ")} {...props}>
      <div className={styles.content}>{children}</div>
    </div>
  );
}
