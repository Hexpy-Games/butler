import { Children, isValidElement, type ReactNode } from "react";

const SCHEME = /^https?:\/\//i;

/** True for absolute http(s) URLs: the links InlineReference opens in the browser. */
export function isExternalHref(href: string | undefined): href is string {
  if (!href || !SCHEME.test(href)) return false;
  try {
    return Boolean(new URL(href).hostname);
  } catch {
    return false;
  }
}

/** Plain text of a React subtree (streaming reveal spans included). */
export function nodeText(node: ReactNode): string {
  let text = "";
  Children.forEach(node, (child) => {
    if (typeof child === "string" || typeof child === "number") text += String(child);
    else if (isValidElement<{ children?: ReactNode }>(child)) text += nodeText(child.props.children);
  });
  return text;
}

/** True when the link text is the URL itself (a bare or autolinked URL). */
export function isBareUrlText(text: string, href: string): boolean {
  const value = text.trim();
  if (!value) return true;
  const strip = (url: string) => url.replace(SCHEME, "").replace(/\/$/, "").toLowerCase();
  return strip(value) === strip(href);
}

/**
 * The domain shown for a bare URL, without `www.`. Prefers the host as
 * written in `text`, so internationalized domains stay readable (not punycode).
 */
export function externalHrefLabel(href: string, text = ""): string {
  let host = text.trim().replace(SCHEME, "").match(/^[^/?#:\s]+/)?.[0] ?? "";
  if (!host) {
    try {
      host = new URL(href).hostname;
    } catch {
      host = href;
    }
  }
  return host.replace(/^www\./i, "");
}
