import type { DsPrivateStyleProps, DsBaseProps } from "../../lib/dsProps";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";
import styles from "./SurfacePanel.module.css";

export interface SurfacePanelProps extends DsPrivateStyleProps, DsBaseProps<HTMLAttributes<HTMLDivElement>> {
  /** Panel content */
  children: ReactNode;
  /** Elevation level; `subtle` is a flat, translucent raised surface (documents inside a message). */
  elevation?: "none" | "subtle" | "low" | "medium" | "high";
  /** Corner radius tier. `control` (default): --radius-control (8px). `lg`:
   * --radius-popover (12px), for a panel that sits in the conversation beside bubbles. */
  radius?: "control" | "lg";
}

export function SurfacePanel({
  children,
  elevation = "low",
  radius = "control",
  className,
  ...props
}: SurfacePanelProps) {
  return (
    <div
      className={cn(
        styles.panel,
        styles[`elevation-${elevation}`],
        radius === "lg" && styles.radiusLg,
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
