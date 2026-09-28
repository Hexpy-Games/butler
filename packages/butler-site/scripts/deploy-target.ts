/**
 * Deploy target for the site: the root of its GitHub Pages custom domain
 * (butler.hexpy.games). SITE_DOMAIN switches the domain (it also becomes the
 * CNAME in the build); SITE_URL and SITE_BASE override the URL and base path,
 * e.g. for a local preview under a sub-path.
 */
export const DEFAULT_SITE_DOMAIN = "butler.hexpy.games";

export interface DeployTarget {
  /** Custom domain, written to dist/CNAME. */
  domain: string;
  site: string;
  base: string;
}

type Env = Record<string, string | undefined>;

const HOST_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/iu;

function normalizeBase(base: string): string {
  const trimmed = base.replace(/^\/+|\/+$/gu, "");
  return trimmed ? `/${trimmed}/` : "/";
}

export function resolveDeployTarget(env: Env = process.env): DeployTarget {
  const domain = env.SITE_DOMAIN?.trim() || DEFAULT_SITE_DOMAIN;
  if (!HOST_NAME.test(domain)) throw new Error(`SITE_DOMAIN must be a bare host name, got "${domain}"`);
  return {
    domain,
    site: (env.SITE_URL ?? `https://${domain}`).replace(/\/+$/u, ""),
    base: normalizeBase(env.SITE_BASE ?? "/"),
  };
}
