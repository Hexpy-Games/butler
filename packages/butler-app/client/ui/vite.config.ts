import path from "node:path";
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

export default defineConfig({
  base: "./",
  plugins: [hugeiconsPureAnnotationPatch(), react()],
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
