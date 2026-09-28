import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

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

// Bundled fonts are OFL 1.1: ship their license texts next to index.html.
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

export default defineConfig({
  cacheDir: path.join(
    process.env.BUTLER_DATA || path.join(homedir(), ".butler"), "cache", "vite",
    createHash("sha256").update(srcRoot).digest("hex").slice(0, 12),
  ),
  base: "./",
  plugins: [hugeiconsPureAnnotationPatch(), react(), fontLicenseNotices()],
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
