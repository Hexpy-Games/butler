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

if (args[0] === "install") {
  const windows = process.platform === "win32";
  const installer = join(root, windows ? "install.ps1" : "install.sh");
  if (!existsSync(installer)) fail("install.sh is missing; run `npm pack` (its prepack step bundles it)");
  const installerEnv = { BUTLER_VERSION: version, ...process.env };
  if (windows) {
    // A pwsh -> Node -> Windows PowerShell chain retains incompatible pwsh modules.
    for (const key of Object.keys(installerEnv)) {
      if (key.toLowerCase() === "psmodulepath") delete installerEnv[key];
    }
    installerEnv.PSModulePath = join(process.env.SystemRoot || "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "Modules");
  }
  run(windows ? "powershell.exe" : "sh", [
    ...(windows ? ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"] : []),
    installer, ...args.slice(1),
  ], installerEnv);
}

if (process.platform === "win32") {
  const home = process.env.BUTLER_AGENT_HOME || join(process.env.LOCALAPPDATA, "Butler", "agent");
  const current = join(home, "current");
  if (!existsSync(current)) fail(`Butler is not installed. Run: npx ${name} install`);
  const target = readFileSync(current, "utf8").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(target) || target.includes("..")) fail("Invalid installation pointer");
  const install = join(home, target);
  run(join(install, "butler-agent.exe"), ["--installation-root", install,
    "--resource-root", join(install, "resources"), ...args]);
}

// Not `butler` from PATH: that could be an npm shim of this very package.
const launcher = join(process.env.BUTLER_BIN_DIR || join(homedir(), ".local", "bin"), "butler");
if (!existsSync(launcher)) fail(`Butler is not installed. Run: npx ${name} install`);
run(launcher, args);
