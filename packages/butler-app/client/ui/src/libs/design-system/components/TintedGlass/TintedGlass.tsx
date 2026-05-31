import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";
import styles from "./TintedGlass.module.css";

export type TintedGlassRadius = "control" | "panel" | "popover" | "composer";
export type TintedGlassPadding = "none" | "sm" | "md" | "lg";
type TintedGlassElement = "div" | "section" | "aside";

export interface TintedGlassProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  as?: TintedGlassElement;
  radius?: TintedGlassRadius;
  padding?: TintedGlassPadding;
}

export const tintedGlassSurfaceClassName = styles.surface;

export function TintedGlass({
  as: Component = "div",
  children,
  className,
  padding = "md",
  radius = "panel",
  ...props
}: TintedGlassProps) {
  return (
    <Component
      className={cn(styles.surface, className)}
      data-padding={padding}
      data-radius={radius}
      data-slot="tinted-glass"
      {...props}
    >
      {children}
    </Component>
  );
}
