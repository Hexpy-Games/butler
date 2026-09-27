import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";
import { readFileSync } from "node:fs";
import { resolveDeployTarget } from "./scripts/deploy-target";
import { syntaxRoleTransformer, syntaxTheme } from "./src/ds/lib/highlight";

// GitHub Pages project page (owner/repo from GITHUB_REPOSITORY or the git
// remote); SITE_URL / SITE_BASE override.
const { site, base } = resolveDeployTarget();
const version = readFileSync(new URL("../../VERSION", import.meta.url), "utf8").trim();

export default defineConfig({
  site,
  base,
  trailingSlash: "always",
  i18n: {
    defaultLocale: "ko",
    locales: ["ko", "en"],
    routing: { prefixDefaultLocale: false },
  },
  // The intro page comes later; the root opens the docs for now.
  redirects: { "/": `${base}docs/` },
  integrations: [react(), mdx(), sitemap()],
  vite: {
    define: { "import.meta.env.BUTLER_VERSION": JSON.stringify(version) },
  },
  markdown: {
    shikiConfig: { theme: syntaxTheme, transformers: [syntaxRoleTransformer] },
  },
});
