/**
 * GitHub Pages has no server redirects, so the root (kept for a later intro
 * page) and the old /docs/ URLs are static pages that forward to the manual
 * under /help/ (RedirectPage.astro). Only manual pages go in the sitemap.
 */
import { docsRoot } from "./nav";
import { LOCALES } from "./sections";

/** Inline script for a redirect page: meta refresh drops the #anchor of a shared link, this keeps it. */
export function redirectScript(target: string): string {
  return `location.replace(${JSON.stringify(target).replace(/</gu, "\\u003c")} + location.hash);`;
}

/** Sitemap filter: manual pages only, never the root or legacy redirects. */
export function isManualPage(url: string, base: string): boolean {
  const { pathname } = new URL(url);
  return LOCALES.some((locale) => pathname.startsWith(docsRoot(base, locale)));
}
