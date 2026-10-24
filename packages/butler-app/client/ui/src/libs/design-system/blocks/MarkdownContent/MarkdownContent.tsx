import type { DsBaseProps } from "../../lib/dsProps";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { MarkdownFaviconContext, type MarkdownFaviconSource } from "./MarkdownLink";
import styles from "./MarkdownContent.module.css";

export interface MarkdownContentProps extends DsBaseProps<HTMLAttributes<HTMLDivElement>> {
  children: ReactNode;
  /** Favicon URL for an external link rendered by MarkdownLink; omit for the globe icon. */
  faviconSrc?: MarkdownFaviconSource;
  /** `compact` for a dense pane (a detail aside, a card): body line height and tighter block spacing. Default `document`. */
  density?: "document" | "compact";
}

export function MarkdownContent({
  children,
  className,
  faviconSrc,
  density = "document",
  ...props
}: MarkdownContentProps) {
  return (
    <div className={cn(styles.markdown, className)} data-density={density === "compact" ? "compact" : undefined} {...props}>
      <MarkdownFaviconContext.Provider value={faviconSrc}>{children}</MarkdownFaviconContext.Provider>
    </div>
  );
}
