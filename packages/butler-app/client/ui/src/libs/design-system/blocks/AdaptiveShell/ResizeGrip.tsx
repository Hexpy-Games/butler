import { tintedGlassSurfaceClassName } from "../../components/TintedGlass";
import { cn } from "../../lib/utils";
import styles from "./ResizeGrip.module.css";

/** The class every AdaptiveShell resize handle carries: it shows the grip and the hint on hover and focus. */
export const resizeHandleClassName = styles.handle;

/**
 * Inside a resize handle: a pill grabber centred on the divider (hover, focus, drag) and, with a `hint`,
 * a two-line hint beside it after the tooltip delay (`title` over `hint`). `side` puts the hint on the
 * DOM side of the divider: never over a native page view. The handle points `aria-describedby` at `id`.
 */
export function ResizeGrip({ id, title, hint, side }: { id: string; title?: string; hint?: string; side: "start" | "end" }) {
  return (
    <>
      <span className={styles.grip} aria-hidden="true" data-slot="resize-grip" />
      {hint ? (
        <span id={id} role="tooltip" className={cn(tintedGlassSurfaceClassName, styles.hint)} data-glass="popover"
          data-radius="control" data-side={side} data-slot="resize-hint">
          {title ? <span className={styles.title}>{title}</span> : null}
          <span className={styles.detail}>{hint}</span>
        </span>
      ) : null}
    </>
  );
}
