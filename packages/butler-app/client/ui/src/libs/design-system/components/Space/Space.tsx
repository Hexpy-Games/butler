import type { HTMLAttributes } from "react";
import styles from "./Space.module.css";

type SpaceSize = "none" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl";
type SpaceDirection = "horizontal" | "vertical";

export interface SpaceProps extends HTMLAttributes<HTMLDivElement> {
  size?: SpaceSize;
  direction?: SpaceDirection;
}

export function Space({
  size = "md",
  direction = "vertical",
  className,
  ...props
}: SpaceProps) {
  const classes = [
    styles.space,
    styles[`size-${size}`],
    styles[`direction-${direction}`],
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <div {...props} aria-hidden="true" className={classes} />;
}

export default Space;
