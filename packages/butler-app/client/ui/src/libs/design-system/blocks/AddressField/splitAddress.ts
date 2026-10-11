/** Host and the rest of a URL, as the address field shows them (no scheme, no trailing slash). */
export function splitAddress(url: string): { host: string; path: string } {
  const value = url.trim();
  if (!value) return { host: "", path: "" };
  try {
    const parsed = new URL(value);
    if (!parsed.host) return { host: value, path: "" };
    const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    let path = rest === "/" ? "" : rest;
    try {
      path = decodeURI(path);
    } catch {
      // Keep the encoded path when it is not valid UTF-8.
    }
    return { host: parsed.host, path };
  } catch {
    return { host: value, path: "" };
  }
}
