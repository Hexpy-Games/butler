import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mergeConfig, type Plugin, type UserConfig } from "vite";
import baseConfig from "./vite.config";

// Static DS Viewer site: `vite build --config vite.ds-site.config.ts` -> dist-ds-site/.
// Same aliases/plugins as the app build (font files + font OFL notices included), rooted at ds-site/
// so its index.html is the site root. Env knobs (see ds-site/README.md):
//   DS_SITE_BASE        public path the site is served under: "/" (default) or e.g. "/ds/".
//   DS_SITE_OUT_DIR     output dir relative to this package; default dist-ds-site for "/" and
//                       dist-ds-site-<base> otherwise, so a sub-path build never clobbers the Pages artifact.
//   DS_SITE_HOST_FILES  "1"/"0": emit the host-owned CNAME + 404.html (default: only when base is "/").
const uiRoot = process.cwd();
const repoRoot = path.resolve(uiRoot, "..", "..", "..", "..");
const siteDir = path.resolve(uiRoot, "ds-site");

/** Normalizes DS_SITE_BASE to "/" or "/segment/.../" (leading + trailing slash, URL-safe segments). */
function dsSiteBase(raw: string | undefined): string {
  const segments = (raw ?? "").trim().split("/").filter(Boolean);
  if (segments.some((segment) => !/^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/.test(segment))) {
    throw new Error(`DS_SITE_BASE must be a path like "/" or "/ds/", got ${JSON.stringify(raw)}`);
  }
  return segments.length ? `/${segments.join("/")}/` : "/";
}

const siteBase = dsSiteBase(process.env.DS_SITE_BASE);
const hostFiles = process.env.DS_SITE_HOST_FILES ? process.env.DS_SITE_HOST_FILES === "1" : siteBase === "/";
const outDir = path.resolve(
  uiRoot,
  process.env.DS_SITE_OUT_DIR || (siteBase === "/" ? "dist-ds-site" : `dist-ds-site-${siteBase.slice(1, -1).split("/").join("-")}`),
);

/**
 * Always emits ds-404-redirect.js (base baked in) for a combined site's 404.html to include. With host
 * files on (the standalone site at "/"), also emits CNAME and a 404.html that inlines the same helper;
 * a combined site owns those, so a sub-path build leaves them out.
 */
function siteRedirect(): Plugin {
  return {
    name: "butler-ds-site-redirect",
    apply: "build",
    generateBundle() {
      const helper = readFileSync(path.join(siteDir, "ds-404-redirect.js"), "utf8")
        .replace('"__DS_SITE_BASE__"', JSON.stringify(siteBase));
      this.emitFile({ type: "asset", fileName: "ds-404-redirect.js", source: helper });
      if (!hostFiles) return;
      this.emitFile({ type: "asset", fileName: "CNAME", source: readFileSync(path.join(siteDir, "host", "CNAME"), "utf8") });
      const page = readFileSync(path.join(siteDir, "host", "404.html"), "utf8")
        .replace("__DS_404_REDIRECT__", () => helper.trim())
        .replace("__DS_SITE_BASE__", siteBase);
      this.emitFile({ type: "asset", fileName: "404.html", source: page });
    },
  };
}

function packageRootOf(id: string): string | null {
  const marker = `${path.sep}node_modules${path.sep}`;
  const at = id.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = id.slice(at + marker.length).split(path.sep);
  const segments = rest[0]?.startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
  return id.slice(0, at + marker.length) + segments.join(path.sep);
}

function licenseText(root: string): string {
  const file = readdirSync(root).find((name) => /^(licen[cs]e|copying)(\.|$)/i.test(name));
  return file ? readFileSync(path.join(root, file), "utf8").trim() : "";
}

/** Emits LICENSE.txt (Butler, MIT) and third-party-licenses.txt for every npm package in the bundle. */
function siteLicenses(): Plugin {
  return {
    name: "butler-ds-site-licenses",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "LICENSE.txt", source: readFileSync(path.join(repoRoot, "LICENSE"), "utf8") });
      const roots = new Set<string>();
      for (const id of this.getModuleIds()) {
        const root = packageRootOf(id.replace(/\?.*$/, ""));
        if (root && existsSync(path.join(root, "package.json"))) roots.add(root);
      }
      const sections = [...roots]
        .map((root) => {
          const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
            name: string; version: string; license?: string;
          };
          const title = `${pkg.name}@${pkg.version} (${pkg.license ?? "see license text"})`;
          return `${title}\n${"=".repeat(title.length)}\n\n${licenseText(root)}\n`;
        })
        .sort();
      this.emitFile({
        type: "asset",
        fileName: "third-party-licenses.txt",
        source: `Third-party software bundled in the Butler Design System site.\n\n${sections.join("\n\n")}`,
      });
    },
  };
}

export default mergeConfig(baseConfig as UserConfig, {
  root: siteDir,
  publicDir: false,
  // "/" keeps the relative asset URLs the standalone site has always shipped; a sub-path gets absolute
  // ones so assets and fonts resolve whether the page is opened as /ds/ or /ds/index.html.
  base: siteBase === "/" ? "./" : siteBase,
  plugins: [siteLicenses(), siteRedirect()],
  build: {
    rollupOptions: { input: path.join(siteDir, "index.html") },
    outDir,
    emptyOutDir: true,
    sourcemap: false,
  },
} satisfies UserConfig);
