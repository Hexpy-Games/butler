import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

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

/**
 * Splits a label into its first character (plus any leading space) and the
 * rest, so the icon can be glued to that character: the icon never ends a
 * line on its own, and the rest still wraps anywhere. A plain `span` (a
 * streaming reveal chunk) is split inside; any other element is glued whole.
 */
export function splitLabelLead(node: ReactNode): [ReactNode, ReactNode[]] {
  const [first, ...rest] = Children.toArray(node);
  if (first === undefined) return [null, []];
  if (typeof first === "string" || typeof first === "number") {
    const text = String(first);
    const head = text.match(/^\s*./su)?.[0] ?? text;
    return [head, [text.slice(head.length), ...rest]];
  }
  if (isValidElement<{ children?: ReactNode }>(first) && first.type === "span") {
    const element = first as ReactElement<{ children?: ReactNode }>;
    const [head, tail] = splitLabelLead(element.props.children);
    return [cloneElement(element, {}, head), [cloneElement(element, { key: "tail" }, ...tail), ...rest]];
  }
  return [first, rest];
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
