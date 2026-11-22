/** Same-origin asset URL: cookies in the web app, authenticated protocol proxy on desktop. */
export function faviconSrc(href: string): string | undefined {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    const host = url.hostname;
    if (!host.includes(".") || /^[\d.]+$/u.test(host) || host.includes(":")) return undefined;
    if (["local", "internal", "localhost", "test"].some((suffix) => host.endsWith(`.${suffix}`))) return undefined;
    if (!host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) return undefined;
    return `/favicons?host=${encodeURIComponent(host)}`;
  } catch {
    return undefined;
  }
}

/** A browser page's icon as the renderer can load it. The page's own icon URL is refused by
 * the app renderer CSP (img-src allows local origins only), so a page that lists an icon shows
 * its site icon through the same-origin proxy. A page the proxy does not serve keeps its own URL,
 * which loads only from 127.0.0.1 or localhost. No icon listed: undefined (the globe). */
export function pageIconSrc(favicon: string, pageUrl: string): string | undefined {
  if (!favicon) return undefined;
  return faviconSrc(pageUrl) ?? favicon;
}
