import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const srcRoot = path.resolve(process.cwd(), "src");
const designSystemRoot = path.resolve(srcRoot, "libs/design-system");

export default defineConfig({
  plugins: [react()],
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
