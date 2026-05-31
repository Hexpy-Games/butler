import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";
import styles from "./SurfacePanel.module.css";

export interface SurfacePanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Panel content */
  children: ReactNode;
  /** Elevation level */
  elevation?: "none" | "low" | "medium" | "high";
  /** Additional CSS class */
  className?: string;
}

export function SurfacePanel({
  children,
  elevation = "low",
  className,
  ...props
}: SurfacePanelProps) {
  return (
    <div
      className={cn(
        styles.panel,
        styles[`elevation-${elevation}`],
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
