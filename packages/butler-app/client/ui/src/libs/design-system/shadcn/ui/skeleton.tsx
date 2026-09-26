import type { CSSProperties, HTMLAttributes } from "react";
import { cn } from "../../lib/utils";
import styles from "../../components/Skeleton/Skeleton.module.css";

/** Fractions of the container, or a number of characters (`ch`). */
export type SkeletonWidth = "full" | "3/4" | "2/3" | "1/2" | "2/5" | "1/3" | "1/4" | number;
/** `line`: a text line; `title`: a heading line; `control`: a control; `row`: a list row (touch target). */
export type SkeletonHeight = "line" | "title" | "control" | "row";
export type SkeletonShape = "rect" | "pill" | "circle";

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /** Accessible loading label; unlabelled skeletons are hidden from assistive technology. */
  label?: string;
  width?: SkeletonWidth;
  height?: SkeletonHeight;
  shape?: SkeletonShape;
  /** Render a paragraph of this many lines with the DS width ramp (width applies to none of them). */
  lines?: number;
}

function widthAttributes(width: SkeletonWidth | undefined): { "data-width"?: string; style?: CSSProperties } {
  if (width === undefined) return {};
  if (typeof width === "number") return { "data-width": "ch", style: { "--skeleton-width": `${width}ch` } as CSSProperties };
  return { "data-width": width };
}

function paragraphWidth(index: number, lines: number): string {
  if (index === lines - 1) return "paragraph-last";
  return index % 2 === 0 ? "paragraph-1" : "paragraph-2";
}

export function Skeleton({ className, label, width, height, shape, lines, style, ...props }: SkeletonProps) {
  if (lines !== undefined) {
    return (
      <div
        aria-hidden={label ? undefined : true}
        className={cn(styles.lines, className)}
        data-slot="skeleton-lines"
        role={label ? "status" : undefined}
        style={style}
        {...props}
      >
        {label ? <span className="sr-only">{label}</span> : null}
        {Array.from({ length: lines }, (_, index) => (
          <div key={index} className={styles.skeleton} data-slot="skeleton" data-width={paragraphWidth(index, lines)}
            data-height={height} data-shape={shape} />
        ))}
      </div>
    );
  }
  const sized = widthAttributes(width);
  return (
    <div
      aria-hidden={label ? undefined : true}
      className={cn(styles.skeleton, className)}
      data-slot="skeleton"
      data-width={sized["data-width"]}
      data-height={height}
      data-shape={shape}
      role={label ? "status" : undefined}
      style={sized.style || style ? { ...sized.style, ...style } : undefined}
      {...props}
    >
      {label ? <span className="sr-only">{label}</span> : null}
    </div>
  );
}
