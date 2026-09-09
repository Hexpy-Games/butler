import type { CSSProperties, FormHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "../../lib/utils";
import { ScrollArea } from "../ScrollArea";
import styles from "./ManagementPage.module.css";

type ManagementPageElement = "section" | "main" | "form";

export interface ManagementPageProps extends FormHTMLAttributes<HTMLFormElement> {
  children: ReactNode;
  footer?: ReactNode;
  footerPlacement?: "flow" | "overlay";
  footerReserve?: number;
  scrollRef?: Ref<HTMLDivElement>;
  as?: ManagementPageElement;
  dataTestClass?: string;
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
        className={styles.scrollArea}
        contentClassName={styles.content}
      >
        {children}
      </ScrollArea>
      {footer && (footerPlacement === "overlay" ? footer : <div className={styles.footer}>{footer}</div>)}
    </Component>
  );
}
