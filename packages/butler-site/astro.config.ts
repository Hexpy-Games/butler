import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import type { AstroIntegration } from "astro";
import { defineConfig } from "astro/config";
import { readFileSync, writeFileSync } from "node:fs";
import { resolveDeployTarget } from "./scripts/deploy-target";
import { syntaxRoleTransformer, syntaxTheme } from "./src/ds/lib/highlight";
import { isManualPage } from "./src/site/redirects";

// Root of the GitHub Pages custom domain (butler.hexpy.games; SITE_DOMAIN,
// SITE_URL and SITE_BASE override). `/` and the old /docs/ URLs are redirect
// pages into the manual at /help/; /ds/ (the DS Viewer) is added after the
// build by scripts/build-ds.ts.
const { domain, site, base } = resolveDeployTarget();
const version = readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim();

/** dist/CNAME for the custom domain, from the same setting as the site URL. */
function cname(): AstroIntegration {
  return {
    name: "butler-cname",
    hooks: {
      "astro:build:done": ({ dir }) => writeFileSync(new URL("CNAME", dir), `${domain}\n`),
    },
  };
}

export default defineConfig({
  site,
  base,
  trailingSlash: "always",
  i18n: {
    defaultLocale: "ko",
    locales: ["ko", "en"],
    routing: { prefixDefaultLocale: false },
  },
  integrations: [react(), mdx(), sitemap({ filter: (page) => isManualPage(page, base) }), cname()],
  vite: {
    define: { "import.meta.env.BUTLER_VERSION": JSON.stringify(version) },
  },
  markdown: {
    shikiConfig: { theme: syntaxTheme, transformers: [syntaxRoleTransformer] },
  },
});
