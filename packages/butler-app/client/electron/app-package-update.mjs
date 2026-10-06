import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync, realpathSync, writeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { windowsPackageVersion } from "./scripts/windows-package-version.mjs";

/** Reverify the DATA-staged package before letting the platform helper activate it. */
export async function prepareAppPackageUpdate({ artifactPath, dataRoot, installation, executable, parent, externalServerUrl = null, arguments: launchArguments = [], onStage = async () => {} }) {
  const staged = JSON.parse(await readFile(resolve(dataRoot, "updates/staged/app.json"), "utf8"));
  const root = realpathSync(resolve(dataRoot, "updates/artifacts"));
  const candidate = realpathSync(artifactPath);
  const within = relative(root, candidate);
  if (!within || within.startsWith("..") || isAbsolute(within) ||
      candidate !== realpathSync(resolve(dataRoot, staged.artifact_path))) {
    throw new Error("Update package is outside verified staging.");
  }
  if (candidate.endsWith(".nupkg") && basename(candidate) !==
      `butler-app-${windowsPackageVersion(staged.available_version)}-full.nupkg`) {
    throw new Error("Squirrel package differs from the selected App version.");
  }
  await onStage("verifying");
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(candidate)) hash.update(bytes);
  if (hash.digest("hex") !== staged.sha256) throw new Error("Update package checksum changed.");
  const log = openSync(resolve(dataRoot, "updates/app-install.log"), "a+", 0o600);
  const env = { ...process.env, ...installation.env };
  // The host publishes its managed Agent URL into process.env at runtime.
  // A replacement must start its own Agent, rather than wait for the stopped one.
  if (externalServerUrl) env.BUTLER_APP_SERVER_URL = externalServerUrl;
  else delete env.BUTLER_APP_SERVER_URL;
  const child = spawn(installation.command, [
    ...installation.args, "app-update-install", candidate, executable, String(parent), ...launchArguments,
  ], { detached: true, windowsHide: true, stdio: ["pipe", "pipe", log], env });
  if (child.pid) void writeFile(resolve(dataRoot, "updates/app-install.pid"), String(child.pid), { mode: 0o600 }).catch(() => {});
  try { await new Promise((accept, reject) => {
    let tail = "";
    const output = (bytes) => {
      writeSync(log, bytes);
      tail = (tail + bytes.toString()).slice(-128);
      if (!tail.includes("app-update-ready")) return;
      finish();
      void onStage("ready").then(accept, reject);
    };
    child.stdout.on("data", output);
    const timer = setTimeout(() => { finish(); child.kill(); reject(new Error("Update preparation timed out.")); }, 60_000);
    function finish() { child.stdout.off("data", output); clearTimeout(timer); }
    child.on("error", () => { finish(); reject(new Error("Update helper could not start.")); });
    child.on("exit", () => { finish(); reject(new Error("Update package verification failed.")); });
  }); } catch (error) {
    child.stdin.end();
    child.kill();
    throw error;
  } finally { closeSync(log); }
  child.unref();
  return { activate: () => child.stdin.end("activate\n"), cancel: () => child.stdin.end() };
}
