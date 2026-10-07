// Showcase-only favicons: generic shapes as data URIs (the app CSP allows
// `img-src data:`), covering a dark glyph, a colored mark, a wide mark and a
// broken image. Real favicons come from the app's favicon service.
const svg = (body: string, viewBox = "0 0 32 32") =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`)}`;

export const SAMPLE_FAVICONS: Record<string, string> = {
  /** Near-black glyph on transparent: unreadable on dark without the plate. */
  "github.com": svg('<circle cx="16" cy="16" r="15" fill="#1f2328"/><circle cx="16" cy="14" r="6" fill="#fff"/><rect x="13" y="19" width="6" height="9" rx="2" fill="#fff"/>'),
  "www.electronjs.org": svg('<circle cx="16" cy="16" r="13" fill="none" stroke="#2f9fb5" stroke-width="4"/><circle cx="16" cy="16" r="4" fill="#2f9fb5"/>'),
  /** Wide mark: the slot letterboxes it. */
  "docs.example.com": svg('<rect x="1" y="9" width="46" height="14" rx="7" fill="#e8743b"/><circle cx="12" cy="16" r="4" fill="#fff"/>', "0 0 48 32"),
  /** Broken image: the globe stays. */
  "developer.mozilla.org": "data:image/png;base64,AAAA",
};

/** Showcase favicon source: a sample by host, or undefined (globe). */
export function sampleFaviconSrc(href: string): string | undefined {
  try {
    return SAMPLE_FAVICONS[new URL(href).hostname];
  } catch {
    return undefined;
  }
}
