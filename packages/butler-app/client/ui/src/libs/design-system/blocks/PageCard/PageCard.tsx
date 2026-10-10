import { useCallback, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type Ref } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { cn } from "../../lib/utils";
import { NativeViewSlot, type NativeViewBounds, type NativeViewViewport } from "../NativeViewSlot";
import { ProgressMeter } from "../ProgressMeter";
import styles from "./PageCard.module.css";

/** Who holds the tab: nobody, Butler (rotating riso edge), you (strong neutral edge), an approval (static amber). */
export type PageCardHolder = "none" | "butler" | "user" | "waiting";

/** NativeViewSlot bounds plus the corner radius the native view takes (View.setBorderRadius). */
export interface PageCardBounds extends NativeViewBounds {
  radius: number;
}

export interface PageCardProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "children"> {
  holder?: PageCardHolder;
  /** A PageBand attached to the card's top. */
  band?: ReactNode;
  /**
   * Keep one band row (`--browser-band-height`) whether or not a band shows, so a band appearing,
   * changing tone or leaving never moves the native view. Use it for every tab Butler can hold.
   */
  reserveBand?: boolean;
  /** Page load progress (0–100): a 2px line on the card's top edge. Omit when loaded. */
  loading?: number;
  loadingLabel?: string;
  /** Butler's tabs keep a fixed page size (1280×800): scaled to the card, letterboxed, the scale noted below. */
  viewport?: NativeViewViewport;
  /** Where the native view goes, with the card's inner corner radius. */
  onBoundsChange: (bounds: PageCardBounds) => void;
  onOcclusion?: (occluded: boolean) => void;
  /** No native view (no tab, crashed, a DOM page): `children` show instead. */
  hidden?: boolean;
  covered?: boolean;
  stillSrc?: string;
  stillAlt?: string;
  occluderSelector?: string;
  /** DS content under the native view: empty and crashed states (or a stand-in page in previews). */
  children?: ReactNode;
  /** A Butler page drawn as DOM instead of a native view (new tab, library). */
  internal?: ReactNode;
  /** DOM layers over the page area, e.g. a SelectionBar. */
  overlay?: ReactNode;
  /** The positioned page area: pass it to DialogContent `container` to anchor a page dialog. */
  contentRef?: Ref<HTMLDivElement>;
  /** Id of the page area, for the TabStrip `panelId` (role tabpanel). */
  panelId?: string;
}

/**
 * The web page as one elevated card inside BrowserPane: it wraps NativeViewSlot, so the native view's
 * bounds are exactly the card's content area (inside its border, under the band). Holder edges are
 * drawn outside the content, so changing the holder never moves the native view; with `reserveBand`
 * the band row is fixed too, so neither does a band.
 */
export function PageCard({
  holder = "none", band, reserveBand = false, loading, loadingLabel = "Loading", viewport, onBoundsChange, onOcclusion, hidden = false, covered, stillSrc,
  stillAlt, occluderSelector, children, internal, overlay, contentRef, panelId, className, ...props
}: PageCardProps) {
  const inner = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState<number | null>(null);
  const report = useCallback((bounds: NativeViewBounds) => {
    const node = inner.current;
    const computed = node ? getComputedStyle(node) : null;
    const radius = computed ? Math.max(0, parseFloat(computed.borderBottomLeftRadius) - parseFloat(computed.borderBottomWidth)) : 0;
    // The note reads the layout scale (the frame's CSS width over the page width), which equals
    // bounds.scale in the App and stays right inside a scaled preview.
    const area = node?.querySelector<HTMLElement>("[data-slot='native-view-frame']");
    setScale(bounds.visible && viewport && area ? area.offsetWidth / viewport.width : null);
    onBoundsChange({ ...bounds, radius: Number.isFinite(radius) ? radius : 0 });
  }, [onBoundsChange, viewport]);
  const ratio = viewport ? { "--page-card-viewport-ratio": viewport.height / viewport.width } as CSSProperties : undefined;
  return (
    <div {...props} className={cn(styles.card, className)} data-slot="page-card" data-holder={holder}>
      <div ref={inner} className={styles.inner}>
        {loading !== undefined ? (
          <div className={styles.loadLine}><ProgressMeter thin value={loading} ariaLabel={loadingLabel} /></div>
        ) : null}
        {reserveBand ? <div className={styles.bandRow} data-slot="page-card-band">{band}</div> : band}
        <div ref={contentRef} className={styles.content} id={panelId} role={panelId ? "tabpanel" : undefined} style={ratio}
          data-slot="page-card-content">
          {internal ? <div className={styles.internal}>{internal}</div> : (
            <NativeViewSlot className={dsClass(styles.slot)} data-fixed-page={viewport ? "" : undefined} onBoundsChange={report}
              onOcclusion={onOcclusion} hidden={hidden} covered={covered} stillSrc={stillSrc} stillAlt={stillAlt}
              viewport={viewport} occluderSelector={occluderSelector}>
              {children}
            </NativeViewSlot>
          )}
          {viewport && scale !== null && !internal && !hidden ? (
            <span className={styles.scaleNote} data-slot="page-card-scale">
              {`${viewport.width} × ${viewport.height} · ${Math.round(scale * 100)}%`}
            </span>
          ) : null}
          {overlay}
        </div>
      </div>
    </div>
  );
}
