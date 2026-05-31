import type { FormHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { ScrollArea } from "../ScrollArea";
import styles from "./ManagementPage.module.css";

type ManagementPageElement = "section" | "main" | "form";

export interface ManagementPageProps extends FormHTMLAttributes<HTMLFormElement> {
  children: ReactNode;
  as?: ManagementPageElement;
  dataTestClass?: string;
}

export function ManagementPage({
  as: Component = "section",
  children,
  className,
  dataTestClass,
  ...props
}: ManagementPageProps) {
  return (
    <Component
      className={cn(styles.page, className)}
      data-test-class={dataTestClass}
      {...props}
    >
      <ScrollArea
        className={styles.scrollArea}
        contentClassName={styles.content}
      >
        {children}
      </ScrollArea>
    </Component>
  );
}
