#!/usr/bin/env node
// npx @hexpygames/butler install [--version X] [--no-start] [--modify-path]
//   Runs the bundled install.sh (the same installer as the curl one-liner),
//   defaulting to the release that matches this package's version.
// npx @hexpygames/butler <anything else>
//   Runs the installed `butler` with those arguments.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { name, version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`${name}: ${message}\n`);
  process.exit(1);
}

function run(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", env });
  if (result.error) fail(`could not run ${command}: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

if (process.platform === "win32") {
  fail("Windows is not supported yet; a PowerShell installer is planned.");
}

if (args[0] === "install") {
  const installer = join(root, "install.sh");
  if (!existsSync(installer)) fail("install.sh is missing; run `npm pack` (its prepack step bundles it)");
  run("sh", [installer, ...args.slice(1)], { BUTLER_VERSION: version, ...process.env });
}

// Not `butler` from PATH: that could be an npm shim of this very package.
const launcher = join(process.env.BUTLER_BIN_DIR || join(homedir(), ".local", "bin"), "butler");
if (!existsSync(launcher)) fail(`Butler is not installed. Run: npx ${name} install`);
run(launcher, args);
