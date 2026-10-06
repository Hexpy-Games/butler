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
