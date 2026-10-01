import { gzipSync } from "node:zlib";
import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_NOTICES.txt.gz",
        source: gzipSync(readFileSync(noticesFile), { level: 9 }),
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
  plugins: [hugeiconsPureAnnotationPatch(), react(), thirdPartyNotices()],
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
