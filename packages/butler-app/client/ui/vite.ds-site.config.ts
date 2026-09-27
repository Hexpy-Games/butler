import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mergeConfig, type Plugin, type UserConfig } from "vite";
import baseConfig from "./vite.config";

// Static DS Viewer site: `vite build --config vite.ds-site.config.ts` -> dist-ds-site/.
// Same aliases/plugins as the app build (font files + font OFL notices included), rooted at ds-site/
// so its index.html is the site root.
const uiRoot = process.cwd();
const repoRoot = path.resolve(uiRoot, "..", "..", "..", "..");

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
  root: path.resolve(uiRoot, "ds-site"),
  publicDir: path.resolve(uiRoot, "ds-site", "public"),
  base: "./",
  plugins: [siteLicenses()],
  build: {
    outDir: path.resolve(uiRoot, "dist-ds-site"),
    emptyOutDir: true,
    sourcemap: false,
  },
} satisfies UserConfig);
