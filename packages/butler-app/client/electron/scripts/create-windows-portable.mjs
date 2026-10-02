#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(process.argv[2]);
if (process.platform !== "win32" || !existsSync(join(root, "Butler.exe"))) {
  throw new Error("Portable Windows packaging requires a packaged Butler.exe on Windows.");
}
// ZIP copies role aliases. The bundled loader restores NTFS hardlinks on first
// launch, preserving the platform's verified executable identity contract.
const archive = join(dirname(root), `${basename(root)}-portable.zip`);
const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  "Compress-Archive -LiteralPath $env:BUTLER_PORTABLE_ROOT -DestinationPath $env:BUTLER_PORTABLE_ZIP -Force",
], { stdio: "inherit", env: { ...process.env, BUTLER_PORTABLE_ROOT: root, BUTLER_PORTABLE_ZIP: archive } });
if (result.status !== 0) throw new Error("Portable Windows ZIP creation failed.");
console.log(`Portable Windows App: ${archive}`);
