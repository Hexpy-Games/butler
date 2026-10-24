import type { DsBaseProps } from "../../lib/dsProps";
import { createContext, useContext, useState, type CSSProperties, type FormHTMLAttributes, type ReactNode, type Ref } from "react";
import { PageContainer, type PageContainerWidth } from "../../components/PageContainer";
import { tintedGlassSurfaceClassName } from "../../components/TintedGlass";
import { ScrollArea } from "../ScrollArea";
import styles from "./ManagementPage.module.css";
import { dsClass } from "../../lib/internal";
import { cn } from "../../lib/utils";
import { useAsideLayout } from "../../lib/asideLayout";
import { AsideSlot, hasAsideContent, type AsideContent } from "../../lib/AsideSlot";
import { useColumnRect, type ColumnRect } from "../../lib/columnRect";

/** The page width from which the aside docks beside the content (a floating one docks again 32px later). */
export const MANAGEMENT_ASIDE_DOCK_MIN = 1000;

type ManagementPageElement = "section" | "main" | "form";

/**
 * The content column a page background keeps clear: the column's left and right edges and the page's top,
 * in client CSS px. A docked aside extends `right` to its own far edge. Scrolling moves none of them.
 */
export type ManagementPageColumnRect = ColumnRect;

/**
 * How the background sits behind the content. `calm`: a tokenized veil
 * (`--management-page-veil`) lowers its contrast. `none`: shown as is.
 */
export type ManagementPageBackgroundTreatment = "calm" | "none";

export interface ManagementPageProps extends DsBaseProps<FormHTMLAttributes<HTMLFormElement>> {
  children: ReactNode;
  footer?: ReactNode;
  footerPlacement?: "flow" | "overlay";
  footerReserve?: number;
  scrollRef?: Ref<HTMLDivElement>;
  as?: ManagementPageElement;
  dataTestClass?: string;
  /** Page width of the content (PageContainer); default caps at 72rem. */
  width?: PageContainerWidth;
  /**
   * A decorative layer behind the scrolling content, confined to the page
   * (e.g. `<Wallpaper scope="container">`). With one, `ManagementPagePanel`s
   * become TintedGlass surfaces. Omit for the plain page.
   */
  background?: ReactNode;
  /** Default `calm`. */
  backgroundTreatment?: ManagementPageBackgroundTreatment;
  /**
   * A detail beside the content (a selected item). From a 1000px page it docks flat in the right margin
   * and the content and an overlay footer narrow to its left; narrower, it floats on TintedGlass over the
   * page while `asideFloatOpen`. A function gets the layout.
   */
  aside?: AsideContent;
  /** Floating only: whether the aside shows. Docked, it shows whenever `aside` is set. */
  asideFloatOpen?: boolean;
  /** The aside landmark's accessible name. */
  asideLabel?: string;
  /**
   * The content column's edges (a docked aside included) and the page's top, on mount and every resize
   * (never on scroll): the `background`'s keep-out, e.g. a Wallpaper's `columnRect`.
   */
  onColumnRect?: (rect: ManagementPageColumnRect) => void;
}

const PageBackgroundContext = createContext(false);

export function ManagementPage({
  as: Component = "section",
  children,
  footer,
  footerPlacement = "flow",
  footerReserve = 0,
  scrollRef,
  className,
  dataTestClass,
  style,
  width = "default",
  background,
  backgroundTreatment = "calm",
  aside,
  asideFloatOpen = false,
  asideLabel,
  onColumnRect,
  ...props
}: ManagementPageProps) {
  const hasBackground = background !== undefined && background !== null;
  const [element, setElement] = useState<HTMLElement | null>(null);
  const asideLayout = useAsideLayout(element, hasAsideContent(aside), MANAGEMENT_ASIDE_DOCK_MIN);
  const asideState = hasAsideContent(aside) && (asideLayout === "docked" || asideFloatOpen) ? asideLayout ?? undefined : undefined;
  const [column, setColumn] = useState<HTMLElement | null>(null);
  useColumnRect(column, element, asideState === "docked" ? "management-page-aside" : null, onColumnRect);
  return (
    <Component
      className={cn(styles.page, footer && (footerPlacement === "overlay" ? styles.withOverlay : styles.withFooter), className)}
      style={{ ...style, "--footer-reserve": `${footerReserve}px` } as CSSProperties}
      data-test-class={dataTestClass}
      data-aside={asideState}
      ref={setElement}
      {...props}
    >
      {hasBackground && (
        <div aria-hidden="true" className={styles.background} data-slot="management-page-background" data-treatment={backgroundTreatment}>
          {background}
        </div>
      )}
      <ScrollArea
        scrollRef={scrollRef}
        className={dsClass(styles.scrollArea)}
        contentClassName={dsClass(styles.content)}
      >
        <PageContainer width={width} className={dsClass(styles.pageContent)} ref={setColumn}>
          <PageBackgroundContext.Provider value={hasBackground}>{children}</PageBackgroundContext.Provider>
        </PageContainer>
      </ScrollArea>
      {footer && (footerPlacement === "overlay" ? footer : <div className={styles.footer}>{footer}</div>)}
      <AsideSlot aside={aside} layout={asideLayout} floatOpen={asideFloatOpen} slot="management-page-aside" label={asideLabel}
        className={styles.aside} glassClassName={styles.asideGlass} />
    </Component>
  );
}

export interface ManagementPagePanelProps {
  children: ReactNode;
  /** The panel surface, e.g. to measure a header for the background's `contentRect`. */
  ref?: Ref<HTMLDivElement>;
}

/**
 * A content group of a ManagementPage. Over a page background it is a
 * TintedGlass surface so its text stays readable; on a plain page it adds
 * nothing, not even DOM.
 */
export function ManagementPagePanel({ children, ref }: ManagementPagePanelProps) {
  if (!useContext(PageBackgroundContext)) return <>{children}</>;
  return (
    <div ref={ref} className={cn(tintedGlassSurfaceClassName, styles.panel)} data-slot="management-page-panel">
      {children}
    </div>
  );
}
