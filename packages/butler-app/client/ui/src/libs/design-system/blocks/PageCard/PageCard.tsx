import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type Ref } from "react";
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
   * changing tone or leaving never moves the native view. Use it for every tab in BrowserPane;
   * with no band the row is empty and the card surface starts under it, so the row reads as the pane
   * around the toolbar and a band arriving extends the card up over it.
   */
  reserveBand?: boolean;
  /** Page load progress (0–100): a 2px line on the card's top edge. Omit when loaded. */
  loading?: number;
  loadingLabel?: string;
  /**
   * Butler's tabs keep a fixed page size (1280×800): the page fits the card's width and the card ends with it
   * (its scale noted below), so no empty band is left under the page. Only a pane wider than the page's
   * aspect letterboxes it at the sides.
   */
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
  /** A Butler page drawn as DOM instead of a native view (new tab, library). The slot is its scroller: pass the page without a ScrollArea of its own. */
  internal?: ReactNode;
  /** DOM layers over the page area, e.g. a SelectionBar. */
  overlay?: ReactNode;
  /** The positioned page area: pass it to DialogContent `container` to anchor a page dialog. */
  contentRef?: Ref<HTMLDivElement>;
  /** Id of the page area, for the TabStrip `panelId` (role tabpanel). */
  panelId?: string;
}

/**
 * The native view takes one radius for all four corners (View.setBorderRadius): the card inner radius
 * where a page corner meets a corner of the card surface, else 0, so the page stays square under a band
 * and beside a letterbox. A page that reaches the card bottom corners keeps the radius under a band too.
 */
function pageRadius(inner: HTMLElement, frame: HTMLElement | null) {
  const computed = getComputedStyle(inner);
  const border = parseFloat(computed.borderBottomWidth) || 0;
  const radius = Math.max(0, parseFloat(computed.borderBottomLeftRadius) - border);
  const content = inner.querySelector<HTMLElement>("[data-slot=page-card-content]");
  if (!frame || !content || !Number.isFinite(radius) || radius === 0) return 0;
  const box = inner.getBoundingClientRect(), area = content.getBoundingClientRect(), page = frame.getBoundingClientRect();
  const tolerance = radius * (inner.offsetWidth ? box.width / inner.offsetWidth : 1);
  const row = inner.querySelector<HTMLElement>("[data-slot=page-card-band]");
  // With an empty reserved row the surface starts under the row (see .card in the CSS).
  const surfaceTop = row && row.childElementCount === 0 ? row.getBoundingClientRect().bottom : box.top + border;
  const sides = page.left - area.left <= tolerance && area.right - page.right <= tolerance;
  const top = page.top - surfaceTop <= tolerance, bottom = area.bottom - page.bottom <= tolerance;
  return sides && (top || bottom) ? radius : 0;
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
  const last = useRef<NativeViewBounds | null>(null);
  const [scale, setScale] = useState<number | null>(null);
  const report = useCallback((bounds: NativeViewBounds) => {
    last.current = bounds;
    const node = inner.current;
    // The note reads the layout scale (the frame CSS width over the page width), which equals
    // bounds.scale in the App and stays right inside a scaled preview.
    const area = node?.querySelector<HTMLElement>("[data-slot=native-view-frame]") ?? null;
    setScale(bounds.visible && viewport && area ? area.offsetWidth / viewport.width : null);
    onBoundsChange({ ...bounds, radius: node ? pageRadius(node, area) : 0 });
  }, [onBoundsChange, viewport]);
  // A band arriving or leaving keeps the bounds but can change the page corners: report again.
  const bandShown = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const row = inner.current?.querySelector("[data-slot=page-card-band]");
    const shown = Boolean(row?.childElementCount);
    if (bandShown.current === shown) return;
    const first = bandShown.current === null;
    bandShown.current = shown;
    if (!first && last.current) report(last.current);
  });
  const fixedPage = Boolean(viewport) && !internal;
  const note = viewport && scale !== null && fixedPage && !hidden
    ? `${viewport.width} × ${viewport.height} · ${Math.round(scale * 100)}%` : null;
  const ratio = viewport ? { "--page-card-viewport-width": viewport.width, "--page-card-viewport-height": viewport.height } as CSSProperties : undefined;
  return (
    <div {...props} className={cn(styles.card, className)} data-slot="page-card" data-holder={holder}
      data-fixed-page={fixedPage ? "" : undefined}>
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
          {overlay}
        </div>
      </div>
      {note ? <span className={styles.scaleNote} data-slot="page-card-scale">{note}</span> : null}
    </div>
  );
}
