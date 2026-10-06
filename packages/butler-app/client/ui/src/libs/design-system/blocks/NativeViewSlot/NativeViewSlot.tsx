import { useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import type { NativeViewBounds, NativeViewViewport } from "./nativeViewGeometry";
import { createNativeViewTracker, type NativeViewTracker } from "./nativeViewTracker";
import styles from "./NativeViewSlot.module.css";

export interface NativeViewSlotProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "children"> {
  /** Where to put the native view; called at most once per frame, only on change. */
  onBoundsChange: (bounds: NativeViewBounds) => void;
  /** True while a DS overlay overlaps the slot or a panel animates across it. */
  onOcclusion?: (occluded: boolean) => void;
  /** No native view right now (no tab, crashed page): reports visible=false and shows `children`. */
  hidden?: boolean;
  /** Forces the covered state for occluders the DOM cannot see (a native menu). */
  covered?: boolean;
  /** A still of the page, shown in place of the native view while it is covered. */
  stillSrc?: string;
  /** Alt text of the still; empty (decorative) by default. */
  stillAlt?: string;
  /** Fixed logical page size (agent tabs): the frame keeps its aspect and bounds report its scale. */
  viewport?: NativeViewViewport;
  /** Extra overlay selector for App surfaces that are not DS overlays. */
  occluderSelector?: string;
  /** DS content under the native view: the empty and crashed states. */
  children?: ReactNode;
}

/**
 * Reserves the rectangle a native Electron WebContentsView is laid over and reports it. Pure UI:
 * no Electron imports; the App container forwards the callbacks to the main process.
 */
export function NativeViewSlot({
  onBoundsChange, onOcclusion, hidden = false, covered = false, stillSrc, stillAlt = "", viewport, occluderSelector,
  children, className, style, ...props
}: NativeViewSlotProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const tracker = useRef<NativeViewTracker | null>(null);
  const callbacks = useRef({ onBoundsChange, onOcclusion });
  const [occluded, setOccluded] = useState(false);
  const viewportWidth = viewport?.width;
  const viewportHeight = viewport?.height;

  useLayoutEffect(() => {
    callbacks.current = { onBoundsChange, onOcclusion };
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    const target = frameRef.current;
    if (!root || !target) return undefined;
    const instance = createNativeViewTracker({
      root, target, hidden, covered, occluders: occluderSelector, viewport,
      onBounds: (bounds) => callbacks.current.onBoundsChange(bounds),
      onOcclusion: (next) => {
        setOccluded(next);
        callbacks.current.onOcclusion?.(next);
      },
    });
    tracker.current = instance;
    return () => {
      tracker.current = null;
      instance.destroy();
    };
    // The tracker lives as long as the slot; prop changes go through update() below.
  }, []);

  useLayoutEffect(() => {
    const size = viewportWidth && viewportHeight ? { width: viewportWidth, height: viewportHeight } : undefined;
    tracker.current?.update({ hidden, covered, occluders: occluderSelector, viewport: size });
  }, [hidden, covered, occluderSelector, viewportWidth, viewportHeight]);

  const fixed = Boolean(viewportWidth && viewportHeight);
  const aspect = fixed ? { "--native-view-width": viewportWidth, "--native-view-height": viewportHeight } as CSSProperties : undefined;
  return (
    <div ref={rootRef} className={cn(styles.slot, className)} data-slot="native-view-slot" data-fixed={fixed || undefined}
      data-hidden={hidden || undefined} data-occluded={occluded || undefined} style={{ ...aspect, ...style }} {...props}>
      <div ref={frameRef} className={styles.frame} data-slot="native-view-frame">
        {children}
        {occluded && stillSrc && !hidden ? <img className={styles.still} src={stillSrc} alt={stillAlt} draggable={false} /> : null}
      </div>
    </div>
  );
}
