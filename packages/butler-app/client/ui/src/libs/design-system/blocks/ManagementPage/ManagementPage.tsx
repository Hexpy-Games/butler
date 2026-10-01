import type { DsBaseProps } from "../../lib/dsProps";
import { createContext, useContext, type CSSProperties, type FormHTMLAttributes, type ReactNode, type Ref } from "react";
import { PageContainer, type PageContainerWidth } from "../../components/PageContainer";
import { tintedGlassSurfaceClassName } from "../../components/TintedGlass";
import { ScrollArea } from "../ScrollArea";
import styles from "./ManagementPage.module.css";
import { dsClass } from "../../lib/internal";
import { cn } from "../../lib/utils";

type ManagementPageElement = "section" | "main" | "form";

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
  ...props
}: ManagementPageProps) {
  const hasBackground = background !== undefined && background !== null;
  return (
    <Component
      className={cn(styles.page, footer && (footerPlacement === "overlay" ? styles.withOverlay : styles.withFooter), className)}
      style={{ ...style, "--footer-reserve": `${footerReserve}px` } as CSSProperties}
      data-test-class={dataTestClass}
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
        <PageContainer width={width} className={dsClass(styles.pageContent)}>
          <PageBackgroundContext.Provider value={hasBackground}>{children}</PageBackgroundContext.Provider>
        </PageContainer>
      </ScrollArea>
      {footer && (footerPlacement === "overlay" ? footer : <div className={styles.footer}>{footer}</div>)}
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
