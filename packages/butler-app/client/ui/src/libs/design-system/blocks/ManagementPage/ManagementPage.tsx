import type { FormHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "../../lib/utils";
import { ScrollArea } from "../ScrollArea";
import styles from "./ManagementPage.module.css";

type ManagementPageElement = "section" | "main" | "form";

export interface ManagementPageProps extends FormHTMLAttributes<HTMLFormElement> {
  children: ReactNode;
  footer?: ReactNode;
  scrollRef?: Ref<HTMLDivElement>;
  as?: ManagementPageElement;
  dataTestClass?: string;
}

export function ManagementPage({
  as: Component = "section",
  children,
  footer,
  scrollRef,
  className,
  dataTestClass,
  ...props
}: ManagementPageProps) {
  return (
    <Component
      className={cn(styles.page, footer && styles.withFooter, className)}
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
      {footer && <div className={styles.footer}>{footer}</div>}
    </Component>
  );
}
