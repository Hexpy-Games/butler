import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";
import styles from "../../components/Skeleton/Skeleton.module.css";

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  label?: string;
}

export function Skeleton({ className, label, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden={label ? undefined : true}
      className={cn(styles.skeleton, className)}
      data-slot="skeleton"
      role={label ? "status" : undefined}
      {...props}
    >
      {label ? <span className="sr-only">{label}</span> : null}
    </div>
  );
}
