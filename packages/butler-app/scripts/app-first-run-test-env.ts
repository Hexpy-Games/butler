import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const root = process.cwd();
const electronBin = resolve(
  root,
  "packages",
  "butler-app",
  "client",
  "electron",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron",
);
const electronAppRoot = resolve(
  root,
  "packages",
  "butler-app",
  "client",
  "electron",
);
const uiRoot = resolve(root, "packages", "butler-app", "client", "ui", "dist");
const testRoot = resolve(root, ".tmp", "app-first-run");

type Options = {
  cleanOnExit: boolean;
  dataDir?: string;
  electronProfileDir?: string;
  profile?: string;
  reset: boolean;
  serverPort?: number;
};

const baseEnvAllowlist = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSH_AUTH_SOCK",
  "__CF_USER_TEXT_ENCODING",
] as const;

function usage(): string {
  return [
    "Usage: bun run app:first-run:test-env [options]",
    "",
    "Options:",
    "  --profile <name>            Reuse .tmp/app-first-run/<name>.",
    "  --data <path>               Use an explicit Butler data directory.",
    "  --electron-profile <path>   Use an explicit Electron user-data-dir.",
    "  --port <number>             Use an explicit app-server port.",
    "  --reset                     Delete the selected test profile before launch.",
    "  --clean-on-exit             Delete the test profile when Electron exits.",
    "  --help                      Show this help.",
  ].join("\n");
}

function takeValue(args: string[], index: number, name: string): string {
  const current = args[index] ?? "";
  const inline = current.match(new RegExp(`^${name}=(.+)$`, "u"))?.[1];
  if (inline) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} requires a value.`);
  return next;
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    cleanOnExit: false,
    reset: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--reset") {
      options.reset = true;
      continue;
    }
    if (arg === "--clean-on-exit") {
      options.cleanOnExit = true;
      continue;
    }
    if (arg === "--profile" || arg.startsWith("--profile=")) {
      options.profile = takeValue(args, i, "--profile");
      if (arg === "--profile") i += 1;
      continue;
    }
    if (arg === "--data" || arg.startsWith("--data=")) {
      options.dataDir = resolve(takeValue(args, i, "--data"));
      if (arg === "--data") i += 1;
      continue;
    }
    if (arg === "--electron-profile" || arg.startsWith("--electron-profile=")) {
      options.electronProfileDir = resolve(takeValue(args, i, "--electron-profile"));
      if (arg === "--electron-profile") i += 1;
      continue;
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const port = Number(takeValue(args, i, "--port"));
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("--port must be a number from 1 to 65535.");
      }
      options.serverPort = port;
      if (arg === "--port") i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function safeProfileName(value: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9._-]+$/u.test(normalized)) {
    throw new Error("--profile may only contain letters, numbers, dot, dash, and underscore.");
  }
  return normalized;
}

function isInsidePath(parent: string, child: string): boolean {
  const diff = relative(parent, child);
  return diff === "" || (!diff.startsWith("..") && !isAbsolute(diff));
}

function assertNotRealButlerData(path: string): void {
  const realButlerData = resolve(homedir(), ".butler");
  const resolved = resolve(path);
  if (resolved === realButlerData || isInsidePath(realButlerData, resolved)) {
    throw new Error("Refusing to use the real ~/.butler directory for first-run testing.");
  }
}

function assertNotRealElectronProfile(path: string): void {
  const home = homedir();
  const realProfiles = [
    resolve(home, "Library", "Application Support", "Butler"),
    resolve(home, ".config", "Butler"),
    process.env.APPDATA ? resolve(process.env.APPDATA, "Butler") : null,
  ].filter((entry): entry is string => Boolean(entry));
  const resolved = resolve(path);
  if (
    realProfiles.some(
      (profile) => resolved === profile || isInsidePath(profile, resolved),
    )
  ) {
    throw new Error("Refusing to use the normal Butler Electron profile for first-run testing.");
  }
}

function assertSafeDestructivePaths(paths: string[]): void {
  for (const path of paths) {
    if (!isInsidePath(testRoot, path)) {
      throw new Error(`Refusing to reset or clean a path outside ${testRoot}: ${path}`);
    }
  }
}

function cleanSelectedRoots(): void {
  if (options.dataDir || options.electronProfileDir) {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(electronProfileDir, { recursive: true, force: true });
  } else {
    rmSync(runRoot, { recursive: true, force: true });
  }
}

function buildBaseEnv(pathValue: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of baseEnvAllowlist) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (pathValue) env.PATH = pathValue;
  return env;
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a local port.")));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHealth(
  child: ChildProcess,
  url: string,
  timeoutMs = 20_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Electron exited before app-server became healthy: ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      const body = await response.json().catch(() => null);
      if (
        response.ok &&
        body?.protocol_version === "butler.app.v1" &&
        body?.data?.ok === true
      ) {
        return;
      }
    } catch {
      // Retry while Electron starts the managed app-server.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 1500).unref();
}

function listenerPids(port: number): number[] {
  if (process.platform === "win32") return [];
  const result = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  return result.stdout
    .split(/\s+/u)
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function assertPortAvailable(port: number): void {
  const pids = listenerPids(port);
  if (pids.length > 0) {
    throw new Error(
      `Refusing to use port ${port}; already listening pid(s): ${pids.join(", ")}.`,
    );
  }
}

async function waitForPortClear(port: number, timeoutMs = 2500): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (listenerPids(port).length === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const pids = listenerPids(port);
  if (pids.length > 0) {
    throw new Error(
      `Test app-server port ${port} is still listening after cleanup: ${pids.join(", ")}.`,
    );
  }
}

async function cleanupOwnedPort(port: number, ownedPids: Set<number>): Promise<void> {
  if (process.platform === "win32" || ownedPids.size === 0) return;
  const pids = listenerPids(port).filter((pid) => ownedPids.has(pid));
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Best-effort cleanup for the test-owned managed app-server.
    }
  }
  await waitForPortClear(port);
}

function existingNodePath(): string | undefined {
  const result = spawnSync("which", ["node"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

const options = parseOptions(process.argv.slice(2));
const runName = options.profile
  ? safeProfileName(options.profile)
  : new Date().toISOString().replace(/[:.]/gu, "-");
const runRoot = resolve(testRoot, runName);
const dataDir = options.dataDir ?? join(runRoot, "data");
const electronProfileDir =
  options.electronProfileDir ?? join(runRoot, "electron-profile");
const serverPort = options.serverPort ?? (await freePort());
const serverUrl = `http://127.0.0.1:${serverPort}/`;
const healthUrl = new URL("/health", serverUrl).toString();
const nodePath = existingNodePath();
const runtimePath = process.execPath;

assert(existsSync(electronBin), "Electron binary is missing; run npm --prefix packages/butler-app/client/electron install first.");
assert(existsSync(join(uiRoot, "index.html")), "UI dist is missing; run npm --prefix packages/butler-app/client/ui run build first.");
assertNotRealButlerData(dataDir);
assertNotRealElectronProfile(electronProfileDir);
assertPortAvailable(serverPort);

if (options.reset) {
  assertSafeDestructivePaths([dataDir, electronProfileDir]);
  cleanSelectedRoots();
}
if (options.cleanOnExit) {
  assertSafeDestructivePaths([dataDir, electronProfileDir]);
}
mkdirSync(dataDir, { recursive: true });
mkdirSync(electronProfileDir, { recursive: true });

const env: NodeJS.ProcessEnv = {
  ...buildBaseEnv(
    nodePath
      ? `${resolve(nodePath, "..")}:${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`
      : process.env.PATH,
  ),
  BUTLER_HOME: root,
  BUTLER_DATA: dataDir,
  BUTLER_BUN: runtimePath,
  BUTLER_APP_SERVER_PORT: String(serverPort),
  BUTLER_APP_GATEWAY_PID_FILE: "off",
};
delete env.BUTLER_APP_SERVER_URL;
delete env.BUTLER_APP_UI_URL;
delete env.BUTLER_APP_DEV_ORIGIN;
delete env.BUTLER_APP_SERVER_BRIDGE;
delete env.BUTLER_APP_SERVER_DB;
delete env.BUTLER_APP_BUTLER_HOME;

console.log("Butler App first-run test environment");
console.log(`Data: ${dataDir}`);
console.log(`Electron profile: ${electronProfileDir}`);
console.log(`App server: ${serverUrl}`);
console.log("This launches the current App UI in a clean state; it is not proof that the first-run wizard is implemented.");
console.log("Quit Butler from the app/tray, or press Ctrl-C here to stop.");

let ownedListenerPids: Set<number> | undefined;

const electron = spawn(
  electronBin,
  [`--user-data-dir=${electronProfileDir}`, electronAppRoot],
  {
    cwd: root,
    env,
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopChild(electron);
  });
}

try {
  await waitForHealth(electron, healthUrl);
  ownedListenerPids = new Set(listenerPids(serverPort));
  console.log("Ready.");
} catch (error) {
  stopChild(electron);
  const startupListenerPids = new Set(listenerPids(serverPort));
  await cleanupOwnedPort(serverPort, startupListenerPids);
  throw error;
}

const exitCode = await new Promise<number>((resolveExit) => {
  electron.once("exit", (code, signal) => {
    if (code !== null) {
      resolveExit(code);
      return;
    }
    resolveExit(signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1);
  });
});

await cleanupOwnedPort(serverPort, ownedListenerPids ?? new Set<number>());
if (options.cleanOnExit) cleanSelectedRoots();
process.exit(exitCode);
