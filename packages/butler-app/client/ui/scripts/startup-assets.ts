import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/** Same static surface ships in the app and the standalone DS viewer. */
export function startupAssets(root: string): Plugin {
  const shell = resolve(root, "../electron");
  const posters = resolve(root, "src/libs/design-system/blocks/WallpaperPicker/posters");
  return { name: "butler-static-startup", apply: "build", generateBundle() {
    for (const name of ["startup.html", "startup.css", "startup.js"]) {
      this.emitFile({ type: "asset", fileName: name === "startup.html" ? name : `startup/${name}`, source: readFileSync(resolve(shell, "startup", name)) });
    }
    this.emitFile({ type: "asset", fileName: "startup/mark.png", source: readFileSync(resolve(shell, "assets/butler-mark-flat-white.png")) });
    for (const name of readdirSync(posters).filter((name) => name.endsWith(".png") || name === "keys.json")) {
      this.emitFile({ type: "asset", fileName: `startup/posters/${name}`, source: readFileSync(resolve(posters, name)) });
    }
  } };
}
