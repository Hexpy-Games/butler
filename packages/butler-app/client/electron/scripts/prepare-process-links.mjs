#!/usr/bin/env node
// Archives materialize hardlinks as copies. Windows ships only the canonical
// executable; its launcher creates role links. Other platforms restore links
// before signing or archiving.
import { chmodSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { legacyProcessRoleFileNames, processRoleFileNames } from "./process-role-names.mjs";

const binary = resolve(process.argv[2]);
const directory = dirname(binary);
const mode = statSync(directory).mode;
chmodSync(directory, mode | 0o200);
try {
  const aliases = new Set([
    ...processRoleFileNames(),
    ...legacyProcessRoleFileNames(),
  ]);
  for (const alias of aliases) {
    rmSync(join(directory, alias), { force: true });
  }
  if (process.platform !== "win32") {
    const result = spawnSync(binary, ["--prepare-process-links"], { stdio: "inherit" });
    if (result.status !== 0 && result.status !== 2) throw new Error("Could not prepare Agent process role links.");
  }
} finally {
  chmodSync(directory, mode);
}
