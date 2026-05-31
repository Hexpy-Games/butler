import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyDirectory, ensureDir, replaceWithSymlink } from "./fs.js";
import { CliError } from "./errors.js";

export function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function installSkill(options) {
  const target = typeof options.target === "string" && options.target.trim()
    ? options.target.trim()
    : "";
  if (!target) throw new CliError("--target is required");

  const mode = options.mode === "copy" ? "copy" : "symlink";
  const source = packageRoot();
  const destination = join(target, "project-ledger");
  ensureDir(target);

  if (mode === "copy") {
    rmSync(destination, { recursive: true, force: true });
    copyDirectory(source, destination);
  } else {
    replaceWithSymlink(source, destination);
  }

  return {
    mode,
    source,
    destination,
    installed: existsSync(destination),
  };
}
