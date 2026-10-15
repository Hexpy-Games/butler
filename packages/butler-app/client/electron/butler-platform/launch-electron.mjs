import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chromiumLaunchArgs } from "./chromium-features.mjs";

// Resolve the workspace's pinned Electron; no toolchain or system installation.
const executable = createRequire(import.meta.url)("electron");
const result = spawnSync(executable, chromiumLaunchArgs([".", ...process.argv.slice(2)]), {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
