import type { ReactElement, ReactNode } from "react";
import { Globe2 } from "../../components/Icons";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import styles from "./DragPreview.module.css";

export interface DragPreviewImage {
  src: string;
  alt?: string;
}

export interface DragPreviewPoint { x: number; y: number }

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
  /**
   * Floating mode: the pointer, updated on every move. The preview follows it just below and right of the
   * tip, so its badge sits beside the cursor and the target under the tip stays visible. Omit for static
   * rendering (a setDragImage source, a story).
   */
  at?: DragPreviewPoint;
  /** Floating mode: `fixed` (default) takes viewport pixels (clientX/Y); `absolute` the positioned layer's pixels. */
  strategy?: "fixed" | "absolute";
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

/** Floating mode: a pointer-transparent box on --z-drag, moved with translate (no layout per move). */
function Floating({ at, strategy, children }: { at: DragPreviewPoint; strategy: "fixed" | "absolute"; children: ReactElement }) {
  return (
    <div className={styles.floating} data-slot="drag-preview-floating" data-strategy={strategy} style={{ translate: `${at.x}px ${at.y}px` }}
      aria-hidden="true">
      {children}
    </div>
  );
}

type PreviewProps = Omit<DragPreviewProps, "at" | "strategy">;

function Preview({ kind, images = [], count, title = "", icon, invalid = false, className }: PreviewProps) {
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
  const stacked = images.slice(0, 2).reverse();
  const layer = (index: number) => (stacked.length === 1 ? "single" : index === 0 ? "back" : "front");
  return (
    <div className={cn(styles.stack, className)} data-slot="drag-preview" data-kind="elements" data-invalid={invalid || undefined} aria-hidden="true">
      {stacked.map((image, index) => (
        <span key={`${image.src}-${index}`} className={styles.crop} data-layer={layer(index)}>
          <img className={styles.cropImage} src={image.src} alt={image.alt ?? ""} draggable={false} />
        </span>
      ))}
      {invalid ? <span className={styles.badge} data-invalid="true"><NoEntry /></span>
        : total > 1 ? <span className={styles.badge}>{total > 99 ? "99+" : total}</span> : null}
    </div>
  );
}

/**
 * What follows the pointer while picks or a tab are dragged: stacked crops with a count, or the lifted
 * tab. Static (for setDragImage or a story), or floating at `at` over the window or in the overlay layer,
 * where it lifts in once. Lifted on --shadow-drag-lift; purely visual.
 */
export function DragPreview({ at, strategy = "fixed", ...props }: DragPreviewProps) {
  const preview = <Preview {...props} />;
  return at ? <Floating at={at} strategy={strategy}>{preview}</Floating> : preview;
}
