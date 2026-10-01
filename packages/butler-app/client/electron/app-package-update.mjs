import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/** Reverify the DATA-staged package before letting the platform helper activate it. */
export async function prepareAppPackageUpdate({ artifactPath, dataRoot, installation, executable, parent, arguments: launchArguments = [] }) {
  const staged = JSON.parse(await readFile(resolve(dataRoot, "updates/staged/app.json"), "utf8"));
  const root = realpathSync(resolve(dataRoot, "updates/artifacts"));
  const candidate = realpathSync(artifactPath);
  const within = relative(root, candidate);
  if (!within || within.startsWith("..") || isAbsolute(within) ||
      candidate !== realpathSync(resolve(dataRoot, staged.artifact_path))) {
    throw new Error("Update package is outside verified staging.");
  }
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(candidate)) hash.update(bytes);
  if (hash.digest("hex") !== staged.sha256) throw new Error("Update package checksum changed.");
  const log = openSync(resolve(dataRoot, "updates/app-install.log"), "a", 0o600);
  const child = spawn(installation.command, [
    ...installation.args, "app-update-install", candidate, executable, String(parent), ...launchArguments,
  ], { detached: true, stdio: ["pipe", "pipe", log], env: { ...process.env, ...installation.env } });
  closeSync(log);
  await new Promise((accept, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Update preparation timed out.")); }, 60_000);
    child.stdout.on("data", bytes => {
      if (bytes.toString().includes("app-update-ready")) { clearTimeout(timer); accept(); }
    });
    child.on("error", () => { clearTimeout(timer); reject(new Error("Update helper could not start.")); });
    child.on("exit", () => { clearTimeout(timer); reject(new Error("Update package verification failed.")); });
  });
  child.stdout.destroy();
  child.unref();
  return { activate: () => child.stdin.end("activate\n"), cancel: () => child.stdin.end() };
}
