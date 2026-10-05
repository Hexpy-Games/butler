#!/usr/bin/env node
// Opens the lifecycle-windows proposal as REAL Electron windows (frameless, native corners and
// shadow, real size), using the repo's Electron dev dependency. No product code is involved.
//
//   npm --prefix packages/butler-app/client/ui run build:ds-site      # once, or after edits
//   node packages/butler-app/client/ui/ds-site/proposals/lifecycle-windows/electron-preview.mjs \
//     [--window=both|startup|quit] [--build] [--theme=dark] [--wallpaper=butler.bloom] [--surface=panel]
//     [--startup=engine] [--quit=timeout] [--locale=en-US] [--motion=reduced] [--backdrop=poster] [--force=1]
//
// Keys in a window: arrows switch its state, F force-quit flag, T theme, W wallpaper, S surface, L language,
// M motion, B backdrop, P play the stage sequence, Q quit. `--smoke=<dir>` captures each window hidden and exits.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ui = resolve(here, "../../..");
const dist = join(ui, "dist-ds-site");
const args = process.argv.slice(2);

if (args.includes("--build") || !existsSync(join(dist, "index.html"))) {
  console.log("Building the DS site (dist-ds-site)…");
  const build = spawnSync("npm", ["--prefix", ui, "run", "--silent", "build:ds-site"], { stdio: "inherit" });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const require = createRequire(join(ui, "../electron/package.json"));
const electron = require("electron");
const child = spawn(electron, [join(here, "electron-main.mjs"), `--dist=${dist}`, ...args.filter((arg) => arg !== "--build")], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
});
child.on("exit", (code) => process.exit(code ?? 0));
