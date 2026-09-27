import type { DsPrivateStyleProps, DsBaseProps } from "../../lib/dsProps";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";
import styles from "./SurfacePanel.module.css";

export interface SurfacePanelProps extends DsPrivateStyleProps, DsBaseProps<HTMLAttributes<HTMLDivElement>> {
  /** Panel content */
  children: ReactNode;
  /** Elevation level; `subtle` is a flat, translucent raised surface (documents inside a message). */
  elevation?: "none" | "subtle" | "low" | "medium" | "high";
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
