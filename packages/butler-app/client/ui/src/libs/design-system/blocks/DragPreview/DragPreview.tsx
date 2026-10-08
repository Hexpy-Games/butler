import type { ReactNode } from "react";
import { Globe2 } from "../../components/Icons";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import styles from "./DragPreview.module.css";

export interface DragPreviewImage {
  src: string;
  alt?: string;
}

export interface DragPreviewProps extends DsPrivateStyleProps {
  /** `elements`: picked page elements, stacked. `tab`: a browser tab lifted out of the strip. */
  kind: "elements" | "tab";
  /** `elements`: the crops; the first two are stacked. */
  images?: DragPreviewImage[];
  /** `elements`: how many are dragged (the badge); defaults to the number of images. */
  count?: number;
  /** `tab`: the tab title. */
  title?: string;
  /** `tab`: the site icon (a 16px img); a globe when missing. */
  icon?: ReactNode;
  /** Over a target that cannot take it: the no-entry badge replaces the count. */
  invalid?: boolean;
}

/** The no-entry badge: a circle with a bar. */
function NoEntry() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" focusable="false" aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2.8 9.2 9.2 2.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * What follows the pointer while picks or a tab are dragged (render it for setDragImage or in the overlay
 * layer): stacked crops with a count, or the lifted tab. Lifted on --shadow-drag-lift; purely visual.
 */
export function DragPreview({ kind, images = [], count, title = "", icon, invalid = false, className }: DragPreviewProps) {
  if (kind === "tab") {
    return (
      <div className={cn(styles.tab, className)} data-slot="drag-preview" data-kind="tab" data-invalid={invalid || undefined} aria-hidden="true">
        <span className={styles.favicon}>{icon ?? <Globe2 size="md" />}</span>
        <span className={styles.title}>{title}</span>
        {invalid ? <span className={styles.badge} data-invalid="true"><NoEntry /></span> : null}
      </div>
    );
  }
  const total = count ?? images.length;
  return (
    <div className={cn(styles.stack, className)} data-slot="drag-preview" data-kind="elements" data-invalid={invalid || undefined} aria-hidden="true">
      {images.slice(0, 2).reverse().map((image, index) => (
        <img key={`${image.src}-${index}`} className={styles.crop} src={image.src} alt={image.alt ?? ""} draggable={false} />
      ))}
      {invalid ? <span className={styles.badge} data-invalid="true"><NoEntry /></span>
        : total > 1 ? <span className={styles.badge}>{total > 99 ? "99+" : total}</span> : null}
    </div>
  );
}
