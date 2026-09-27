/**
 * Docs content links pages root-relative (/docs/<slug>/); the MDX `a`
 * override (DocLink.tsx) adds the deploy base so content never hardcodes it.
 */
import { withBase } from "./nav";

const ROOT_RELATIVE = /^\/(?!\/)/u;

export function withBaseHref(base: string, href: string | undefined): string | undefined {
  return href && ROOT_RELATIVE.test(href) ? withBase(base, href) : href;
}
