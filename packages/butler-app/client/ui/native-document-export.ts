// Bundle the existing Electron document renderer for the native shell's hidden CEF page.
import { build } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const root = path.resolve(import.meta.dirname);
const ds = path.join(root, "src/libs/design-system");
await build({
  configFile: false, root, plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: { alias: [
    { find: /^@\/butler-ds\/(.+)$/, replacement: `${ds}/$1` },
    { find: "@/butler-ds", replacement: path.join(ds, "index.ts") },
    { find: "@", replacement: path.join(root, "src") },
  ] },
  build: {
    outDir: process.argv[2], emptyOutDir: true, assetsInlineLimit: () => true,
    cssCodeSplit: false,
    lib: { entry: path.join(root, "src/components/documents/nativeDocumentExport.tsx"), formats: ["iife"], name: "DocumentExport", fileName: () => "document.js", cssFileName: "document" },
  },
});
