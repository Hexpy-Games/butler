import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { lifecycleOutput, checkLifecycleAssets } from "./lifecycle-window-build";

/** The app and DS site ship the same captured DS surface. */
export function startupAssets(_root: string): Plugin {
  return { name: "butler-lifecycle-assets", apply: "build",
    buildStart() { checkLifecycleAssets(); },
    generateBundle() {
      for (const name of ["lifecycle.html", "mark.js", "state.js", "copy.json", "manifest.json"]) {
        this.emitFile({ type: "asset", fileName: `lifecycle/${name}`, source: readFileSync(resolve(lifecycleOutput, name)) });
      }
    },
  };
}
