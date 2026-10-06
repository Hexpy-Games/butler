import { createContext, useContext, type AnchorHTMLAttributes } from "react";
import { InlineReference, isExternalHref } from "../../components/InlineReference";

/** Maps an external href to a same-origin favicon URL, or undefined for the globe. */
export type MarkdownFaviconSource = (href: string) => string | undefined;

export const MarkdownFaviconContext = createContext<MarkdownFaviconSource | undefined>(undefined);

/**
 * Markdown link renderer (react-markdown `components.a`). http(s) links render
 * as an external InlineReference with the favicon from MarkdownContent's
 * `faviconSrc`; mailto, fragment and relative links stay plain anchors routed
 * to the system handler as before. Like MarkdownTable, it keeps the plain
 * element props react-markdown passes.
 */
export function MarkdownLink({
  node: _node,
  href,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const faviconSrc = useContext(MarkdownFaviconContext);
  if (!href) return <span>{children}</span>;
  if (isExternalHref(href)) {
    return <InlineReference kind="external" href={href} iconSrc={faviconSrc?.(href)}>{children}</InlineReference>;
  }
  return <a {...props} href={href} rel="noopener noreferrer" target="_blank">{children}</a>;
}
