import { reducedMotionCss } from "./scripts/reduced-motion-css";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { startupAssets } from "./scripts/startup-assets";
import { checkWallpaperPosters } from "./scripts/check-wallpaper-posters";

const srcRoot = path.resolve(process.cwd(), "src");
const designSystemRoot = path.resolve(srcRoot, "libs/design-system");

function hugeiconsPureAnnotationPatch(): Plugin {
  return {
    name: "butler-hugeicons-pure-annotation-patch",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("@hugeicons/core-free-icons")) return null;
      if (!code.includes("/*#__PURE__*/")) return null;
      return {
        code: code.replaceAll("/*#__PURE__*/", ""),
        map: null,
      };
    },
  };
}

// Font OFL texts remain readable beside index.html; the full inventory stays compressed.
function fontLicenseNotices(): Plugin {
  const require = createRequire(import.meta.url);
  const notices: Array<[name: string, file: string]> = [
    ["Pretendard Variable 1.3.9", require.resolve("pretendard/dist/LICENSE.txt")],
    ["IBM Plex Mono 2.5.0", path.resolve(designSystemRoot, "fonts/ibm-plex-mono/LICENSE.txt")],
  ];
  return {
    name: "butler-font-license-notices",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_NOTICES.txt",
        source: notices
          .map(([name, file]) => `${name}\n${"=".repeat(name.length)}\n\n${readFileSync(file, "utf8").trim()}\n`)
          .join("\n\n"),
      });
    },
  };
}

// Generate the union inventory at build time; also served by the headless Agent.
function thirdPartyNotices(): Plugin {
  const repositoryRoot = path.resolve(process.cwd(), "../../../..");
  const noticesFile = path.join(repositoryRoot, "deploy/licenses/THIRD_PARTY_NOTICES.txt");
  return {
    name: "butler-third-party-notices",
    apply: "build",
    buildStart() {
      execFileSync(process.execPath, [path.join(repositoryRoot, "deploy/licenses/generate.mjs")]);
      execFileSync(process.execPath, [path.join(repositoryRoot, "deploy/licenses/verify-renderer.mjs")]);
    },
    generateBundle(_options, bundle) {
      const modules = Object.values(bundle).flatMap((entry) =>
        entry.type === "chunk" ? Object.keys(entry.modules) : [],
      );
      execFileSync(process.execPath, [path.join(repositoryRoot, "deploy/licenses/verify-renderer.mjs"), "--modules"], {
        input: JSON.stringify(modules),
      });
      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_NOTICES.txt.gz",
        source: gzipSync(readFileSync(noticesFile), { level: 9 }),
      });
    },
  };
}

export default defineConfig({
  css: { postcss: { plugins: [reducedMotionCss()] } },
  cacheDir: path.join(
    process.env.BUTLER_DATA || path.join(homedir(), ".butler"), "cache", "vite",
    createHash("sha256").update(srcRoot).digest("hex").slice(0, 12),
  ),
  base: "./",
  plugins: [startupAssets(process.cwd()), hugeiconsPureAnnotationPatch(), react(), fontLicenseNotices(), thirdPartyNotices(), {
    name: "wallpaper-poster-inputs",
    apply: "build",
    buildStart: () => checkWallpaperPosters(process.cwd()),
  }],
  // Font slices stay files so unicode-range fetches them lazily.
  build: { assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined) },
  resolve: {
    alias: [
      {
        find: /^@\/butler-ds\/(.+)$/,
        replacement: `${designSystemRoot}/$1`,
      },
      {
        find: "@/butler-ds",
        replacement: path.resolve(designSystemRoot, "index.ts"),
      },
      {
        find: "@",
        replacement: srcRoot,
      },
    ],
  },
});
