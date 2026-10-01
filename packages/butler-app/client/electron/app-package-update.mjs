import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, fstatSync, openSync, read, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/** Reverify the DATA-staged package before letting the platform helper activate it. */
export async function prepareAppPackageUpdate({ artifactPath, dataRoot, installation, executable, parent, externalServerUrl = null, arguments: launchArguments = [] }) {
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
  const log = openSync(resolve(dataRoot, "updates/app-install.log"), "a+", 0o600);
  let offset = fstatSync(log).size;
  const env = { ...process.env, ...installation.env };
  // The host publishes its managed Agent URL into process.env at runtime.
  // A replacement must start its own Agent, rather than wait for the stopped one.
  if (externalServerUrl) env.BUTLER_APP_SERVER_URL = externalServerUrl;
  else delete env.BUTLER_APP_SERVER_URL;
  const child = spawn(installation.command, [
    ...installation.args, "app-update-install", candidate, executable, String(parent), ...launchArguments,
  ], { detached: true, stdio: ["pipe", log, log], env });
  try { await new Promise((accept, reject) => {
    const buffer = Buffer.alloc(2048);
    let reading = false, tail = "";
    const poll = setInterval(() => {
      if (reading) return;
      reading = true;
      read(log, buffer, 0, buffer.length, offset, (error, count) => {
        reading = false;
        if (error) { finish(); reject(new Error("Update preparation log unavailable.")); return; }
        offset += count;
        tail = (tail + buffer.subarray(0, count).toString()).slice(-64);
        if (tail.includes("app-update-ready")) { finish(); accept(); }
      });
    }, 100);
    const timer = setTimeout(() => { finish(); child.kill(); reject(new Error("Update preparation timed out.")); }, 60_000);
    function finish() { clearInterval(poll); clearTimeout(timer); }
    child.on("error", () => { finish(); reject(new Error("Update helper could not start.")); });
    child.on("exit", () => { finish(); reject(new Error("Update package verification failed.")); });
  }); } finally { closeSync(log); }
  child.unref();
  return { activate: () => child.stdin.end("activate\n"), cancel: () => child.stdin.end() };
}
