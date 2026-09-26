import type { DsBaseProps } from "../../lib/dsProps";
import type { CSSProperties, FormHTMLAttributes, ReactNode, Ref } from "react";
import { PageContainer, type PageContainerWidth } from "../../components/PageContainer";
import { ScrollArea } from "../ScrollArea";
import styles from "./ManagementPage.module.css";
import { dsClass } from "../../lib/internal";
import { cn } from "../../lib/utils";

type ManagementPageElement = "section" | "main" | "form";

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
}

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
  ...props
}: ManagementPageProps) {
  return (
    <Component
      className={cn(styles.page, footer && (footerPlacement === "overlay" ? styles.withOverlay : styles.withFooter), className)}
      style={{ ...style, "--footer-reserve": `${footerReserve}px` } as CSSProperties}
      data-test-class={dataTestClass}
      {...props}
    >
      <ScrollArea
        scrollRef={scrollRef}
        className={dsClass(styles.scrollArea)}
        contentClassName={dsClass(styles.content)}
      >
        <PageContainer width={width} className={dsClass(styles.pageContent)}>
          {children}
        </PageContainer>
      </ScrollArea>
      {footer && (footerPlacement === "overlay" ? footer : <div className={styles.footer}>{footer}</div>)}
    </Component>
  );
}
