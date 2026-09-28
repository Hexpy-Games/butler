import type { AnchorHTMLAttributes } from "react";
import { withBaseHref } from "./baseLinks";

/** MDX `a` override: root-relative docs links get the deploy base path. */
export function DocLink({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a href={withBaseHref(import.meta.env.BASE_URL, href)} {...props} />;
}
