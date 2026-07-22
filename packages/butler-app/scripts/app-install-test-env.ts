import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { prepareBundledAgentResource } from "./release/package-app-release.ts";

const root = process.cwd();
const electronRoot = resolve(root, "packages", "butler-app", "client", "electron");
const uiRoot = resolve(root, "packages", "butler-app", "client", "ui", "dist");
const packagerBin = resolve(
  electronRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-packager.cmd" : "electron-packager",
);
const macSignScript = resolve(electronRoot, "scripts", "adhoc-sign-mac.mjs");
const butlerIcon = resolve(electronRoot, "assets", "butler.icns");
const testRoot = resolve(root, ".tmp", "app-install");
const userInstallRoot = resolve(
  homedir(),
  "Library",
  "Application Support",
  "Butler Install Tests",
);

type Options = {
  cleanOnExit: boolean;
  dataDir?: string;
  electronProfileDir?: string;
  keepInstall: boolean;
  keepService: boolean;
  profile?: string;
  remoteDebuggingPort?: number;
  reset: boolean;
  serverPort?: number;
  serviceLabel?: string;
  systemdUnit?: string;
  validateOnly: boolean;
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
    "Usage: bun run app:install:test-env [options]",
    "",
    "Options:",
    "  --profile <name>            Reuse .tmp/app-install/<name>.",
    "  --data <path>               Use an explicit Butler data directory.",
    "  --electron-profile <path>   Use an explicit Electron user-data-dir.",
    "  --port <number>             Use an explicit app-server port.",
    "  --remote-debugging-port <n> Enable Chromium DevTools on an isolated port.",
    "  --service-label <label>     LaunchAgent label for the installed test app.",
    "  --systemd-unit <unit>       systemd user unit for the installed test app.",
    "  --keep-install              Leave the test DMG install root after the app exits.",
    "  --keep-service              Leave the test service installed after the app exits.",
    "  --reset                     Delete the selected test profile before packaging.",
    "  --clean-on-exit             Delete data/profile state when the app exits.",
    "  --validate-only             Validate isolation guards without packaging or installing.",
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
    keepInstall: false,
    keepService: false,
    reset: false,
    validateOnly: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
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
    if (arg === "--validate-only") {
      options.validateOnly = true;
      continue;
    }
    if (arg === "--keep-install") {
      options.keepInstall = true;
      continue;
    }
    if (arg === "--keep-service") {
      options.keepService = true;
      continue;
    }
    if (arg === "--profile" || arg.startsWith("--profile=")) {
      options.profile = takeValue(args, index, "--profile");
      if (arg === "--profile") index += 1;
      continue;
    }
    if (arg === "--data" || arg.startsWith("--data=")) {
      options.dataDir = resolve(takeValue(args, index, "--data"));
      if (arg === "--data") index += 1;
      continue;
    }
    if (arg === "--electron-profile" || arg.startsWith("--electron-profile=")) {
      options.electronProfileDir = resolve(takeValue(args, index, "--electron-profile"));
      if (arg === "--electron-profile") index += 1;
      continue;
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const port = Number(takeValue(args, index, "--port"));
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("--port must be a number from 1 to 65535.");
      }
      options.serverPort = port;
      if (arg === "--port") index += 1;
      continue;
    }
    if (
      arg === "--remote-debugging-port" ||
      arg.startsWith("--remote-debugging-port=")
    ) {
      const port = Number(takeValue(args, index, "--remote-debugging-port"));
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("--remote-debugging-port must be a number from 1 to 65535.");
      }
      options.remoteDebuggingPort = port;
      if (arg === "--remote-debugging-port") index += 1;
      continue;
    }
    if (arg === "--service-label" || arg.startsWith("--service-label=")) {
      options.serviceLabel = takeValue(args, index, "--service-label");
      if (arg === "--service-label") index += 1;
      continue;
    }
    if (arg === "--systemd-unit" || arg.startsWith("--systemd-unit=")) {
      options.systemdUnit = takeValue(args, index, "--systemd-unit");
      if (arg === "--systemd-unit") index += 1;
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

function nativeServiceSafeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^-+|-+$/gu, "") || "default";
}

function isInsidePath(parent: string, child: string): boolean {
  const diff = relative(parent, child);
  return diff === "" || (!diff.startsWith("..") && !isAbsolute(diff));
}

function resolveForContainment(path: string): string {
  const resolved = resolve(path);
  if (existsSync(resolved)) return realpathSync.native(resolved);
  const missingSegments: string[] = [];
  let cursor = resolved;
  while (!existsSync(cursor)) {
    const next = dirname(cursor);
    if (next === cursor) return resolved;
    missingSegments.unshift(basename(cursor));
    cursor = next;
  }
  return resolve(realpathSync.native(cursor), ...missingSegments);
}

function isInsideRealPath(parent: string, child: string): boolean {
  return isInsidePath(resolveForContainment(parent), resolveForContainment(child));
}

function assertNotRealButlerData(path: string): void {
  const realButlerData = resolve(homedir(), ".butler");
  const resolved = resolve(path);
  if (resolved === realButlerData || isInsideRealPath(realButlerData, resolved)) {
    throw new Error("Refusing to use the real ~/.butler directory for install testing.");
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
      (profile) => resolved === profile || isInsideRealPath(profile, resolved),
    )
  ) {
    throw new Error("Refusing to use the normal Butler Electron profile for install testing.");
  }
}

function assertSafeWorktreePath(path: string): void {
  if (!isInsideRealPath(testRoot, path)) {
    throw new Error(`Refusing to reset or clean a path outside ${testRoot}: ${path}`);
  }
}

function assertSafeInstallRoot(path: string): void {
  if (!isInsideRealPath(userInstallRoot, path)) {
    throw new Error(`Refusing to remove a path outside ${userInstallRoot}: ${path}`);
  }
}

function assertNativeServiceTestNamespace(input: {
  serviceLabel: string;
  systemdUnit: string;
  serverPort: number;
}): void {
  if (input.serviceLabel === "com.hexpy.butler") {
    throw new Error("Refusing to use the production LaunchAgent label for install testing.");
  }
  if (!/^com\.hexpy\.butler\.test[.A-Za-z0-9_-]*$/u.test(input.serviceLabel)) {
    throw new Error("Install test service label must start with com.hexpy.butler.test.");
  }
  if (input.systemdUnit === "butler.service") {
    throw new Error("Refusing to use the production systemd unit for install testing.");
  }
  if (!/^butler-test[-A-Za-z0-9_.]*\.service$/u.test(input.systemdUnit)) {
    throw new Error("Install test systemd unit must start with butler-test and end with .service.");
  }
  if (input.serverPort === 18765) {
    throw new Error("Refusing to use the production app-server port for install testing.");
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

function cleanupNativeService(input: {
  serviceLabel: string;
  systemdUnit: string;
}): void {
  assertNativeServiceTestNamespace({
    ...input,
    serverPort: 1,
  });
  if (process.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const target = `gui/${uid ?? "$UID"}/${input.serviceLabel}`;
    spawnSync("launchctl", ["bootout", target], { stdio: "ignore" });
    rmSync(join(homedir(), "Library", "LaunchAgents", `${input.serviceLabel}.plist`), {
      force: true,
    });
    return;
  }
  if (process.platform === "linux") {
    spawnSync("systemctl", ["--user", "disable", "--now", input.systemdUnit], {
      stdio: "ignore",
    });
    rmSync(join(homedir(), ".config", "systemd", "user", input.systemdUnit), {
      force: true,
    });
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  }
}

function existingNodePath(): string | undefined {
  const result = spawnSync("which", ["node"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function runRequired(command: string, args: string[], message: string): void {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${message}: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
  }
}

function setPlistString(plistPath: string, key: string, value: string): void {
  const setResult = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Set :${key} ${value}`, plistPath],
    { encoding: "utf8" },
  );
  if (setResult.status === 0) return;
  const addResult = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Add :${key} string ${value}`, plistPath],
    { encoding: "utf8" },
  );
  if (addResult.status !== 0) {
    throw new Error(
      `failed to set ${key}: ${
        addResult.stderr.trim() || setResult.stderr.trim() || "unknown error"
      }`,
    );
  }
}

function normalizeTestMacBundle(input: {
  appBundle: string;
  appName: string;
  bundleId: string;
}): void {
  const plistPath = join(input.appBundle, "Contents", "Info.plist");
  const iconTarget = join(input.appBundle, "Contents", "Resources", "butler.icns");
  copyFileSync(butlerIcon, iconTarget);
  setPlistString(plistPath, "CFBundleDisplayName", input.appName);
  setPlistString(plistPath, "CFBundleName", input.appName);
  setPlistString(plistPath, "CFBundleIdentifier", input.bundleId);
  setPlistString(plistPath, "CFBundleIconFile", "butler.icns");
  setPlistString(plistPath, "CFBundleIconName", "butler");
  runRequired("touch", [input.appBundle], "mac test bundle metadata touch failed");
}

function prepareRendererResource(workDir: string): string {
  const rendererResourceDir = join(workDir, "app-client");
  rmSync(rendererResourceDir, { recursive: true, force: true });
  cpSync(uiRoot, rendererResourceDir, {
    dereference: false,
    errorOnExist: false,
    force: true,
    recursive: true,
  });
  return rendererResourceDir;
}

function packageMacApp(input: {
  appName: string;
  bundleId: string;
  helperBundleId: string;
  outDir: string;
  bundledAgentResourceDir: string;
  rendererResourceDir: string;
}): string {
  const packagerIcon = join(input.outDir, "butler-install-test-icon.icns");
  copyFileSync(butlerIcon, packagerIcon);
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  runRequired(
    packagerBin,
    [
      electronRoot,
      input.appName,
      "--platform=darwin",
      `--arch=${arch}`,
      "--overwrite",
      `--out=${input.outDir}`,
      `--icon=${packagerIcon}`,
      `--app-bundle-id=${input.bundleId}`,
      `--helper-bundle-id=${input.helperBundleId}`,
      `--extra-resource=${input.bundledAgentResourceDir}`,
      `--extra-resource=${input.rendererResourceDir}`,
      "--ignore=^/dist($|/)",
      "--quiet",
    ],
    "electron package failed",
  );
  const appBundle = join(input.outDir, `${input.appName}-darwin-${arch}`, `${input.appName}.app`);
  assert(existsSync(appBundle), `packaged app bundle was not created: ${appBundle}`);
  normalizeTestMacBundle({
    appBundle,
    appName: input.appName,
    bundleId: input.bundleId,
  });
  runRequired("node", [macSignScript, appBundle], "mac ad-hoc signing failed");
  return appBundle;
}

function createMacDmg(input: {
  appBundle: string;
  appName: string;
  outPath: string;
}): void {
  rmSync(input.outPath, { force: true });
  runRequired("hdiutil", [
    "create", "-volname", input.appName, "-srcfolder", input.appBundle,
    "-ov", "-format", "UDZO", input.outPath,
  ], "mac install test DMG creation failed");
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 1500).unref();
}

async function waitForLaunch(child: ChildProcess, timeoutMs = 2500): Promise<void> {
  await new Promise<void>((resolveWait, rejectWait) => {
    const timeout = setTimeout(resolveWait, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectWait(new Error(`Installed Butler test app exited during launch: ${code ?? signal ?? "unknown"}`));
    });
  });
}

const options = parseOptions(process.argv.slice(2));
if (process.platform !== "darwin") {
  throw new Error("App install test environment currently supports macOS DMG installs only.");
}

const runName = options.profile
  ? safeProfileName(options.profile)
  : new Date().toISOString().replace(/[:.]/gu, "-");
const serviceSafeName = nativeServiceSafeName(runName);
const runRoot = resolve(testRoot, runName);
const packageWorkDir = join(runRoot, "package");
const installedRoot = resolve(userInstallRoot, runName);
const dataDir = options.dataDir ?? join(runRoot, "data");
const electronProfileDir =
  options.electronProfileDir ?? join(runRoot, "electron-profile");
const serverPort = options.serverPort ?? (await freePort());
const serviceLabel = options.serviceLabel ?? `com.hexpy.butler.test.${serviceSafeName}`;
const systemdUnit = options.systemdUnit ?? `butler-test-${serviceSafeName}.service`;
const appName = `Butler Install Test ${serviceSafeName}`;
const bundleId = `com.hexpy.butler.test.install.${serviceSafeName}`;
const helperBundleId = `${bundleId}.helper`;
const dmgPath = join(packageWorkDir, `${appName}.dmg`);
const installedApp = join(installedRoot, "Applications", `${appName}.app`);
const executable = join(installedApp, "Contents", "MacOS", appName);
const nodePath = existingNodePath();

assert(existsSync(packagerBin), "Electron packager is missing; run npm --prefix packages/butler-app/client/electron install first.");
assert(existsSync(join(uiRoot, "index.html")), "UI dist is missing; run npm --prefix packages/butler-app/client/ui run build first.");
assert(existsSync(butlerIcon), `Butler icon is missing: ${butlerIcon}`);
assertNotRealButlerData(dataDir);
assertNotRealElectronProfile(electronProfileDir);
assertNativeServiceTestNamespace({ serviceLabel, systemdUnit, serverPort });
assertPortAvailable(serverPort);
if (options.remoteDebuggingPort !== undefined) {
  assert(options.remoteDebuggingPort !== serverPort, "DevTools and app-server ports must differ.");
  assertPortAvailable(options.remoteDebuggingPort);
}

if (options.validateOnly) {
  console.log("Butler App install test environment validation passed.");
  process.exit(0);
}

if (options.reset) {
  assertSafeWorktreePath(runRoot);
  assertSafeInstallRoot(installedRoot);
  rmSync(runRoot, { recursive: true, force: true });
  rmSync(installedRoot, { recursive: true, force: true });
}
if (options.cleanOnExit) {
  assertSafeWorktreePath(dataDir);
  assertSafeWorktreePath(electronProfileDir);
}
assertSafeInstallRoot(installedRoot);
cleanupNativeService({ serviceLabel, systemdUnit });

mkdirSync(packageWorkDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(electronProfileDir, { recursive: true });

const bundledAgent = prepareBundledAgentResource(root, join(packageWorkDir, "bundled-agent-resource"));
const rendererResourceDir = prepareRendererResource(packageWorkDir);
const appBundle = packageMacApp({
  appName,
  bundleId,
  helperBundleId,
  outDir: packageWorkDir,
  bundledAgentResourceDir: bundledAgent.resourceDir,
  rendererResourceDir,
});
createMacDmg({
  appBundle,
  appName,
  outPath: dmgPath,
});
rmSync(installedRoot, { recursive: true, force: true });
mkdirSync(join(installedRoot, "Applications"), { recursive: true });
const mountPoint = join(packageWorkDir, "mounted-dmg");
mkdirSync(mountPoint, { recursive: true });
runRequired("hdiutil", ["attach", dmgPath, "-mountpoint", mountPoint, "-nobrowse"], "mac install test DMG mount failed");
try {
  cpSync(join(mountPoint, `${appName}.app`), installedApp, { recursive: true });
} finally {
  runRequired("hdiutil", ["detach", mountPoint], "mac install test DMG detach failed");
}
assert(existsSync(executable), `installed app executable is missing: ${executable}`);

const env: NodeJS.ProcessEnv = {
  ...buildBaseEnv(
    nodePath
      ? `${resolve(nodePath, "..")}:${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`
      : process.env.PATH,
  ),
  BUTLER_DATA: dataDir,
  BUTLER_APP_ALLOW_NATIVE_SERVICE_TEST_ENV: "1",
  BUTLER_APP_FORCE_NATIVE_SERVICE_BRIDGE: "1",
  BUTLER_APP_GATEWAY_PID_FILE: "off",
  BUTLER_APP_SERVER_PORT: String(serverPort),
  BUTLER_APP_SERVICE_LABEL: serviceLabel,
  BUTLER_APP_SYSTEMD_UNIT: systemdUnit,
  BUTLER_APP_ELECTRON_USER_DATA_DIR: electronProfileDir,
};
delete env.BUTLER_APP_SERVER_URL;
delete env.BUTLER_APP_UI_URL;
delete env.BUTLER_APP_DEV_ORIGIN;
delete env.BUTLER_APP_SERVER_BRIDGE;
delete env.BUTLER_APP_SERVER_DB;
delete env.BUTLER_APP_BUTLER_HOME;
delete env.BUTLER_HOME;
delete env.BUTLER_BUN;

console.log("Butler App install test environment");
console.log(`DMG: ${dmgPath}`);
console.log(`Installed app: ${installedApp}`);
console.log(`Data: ${dataDir}`);
console.log(`Electron profile: ${electronProfileDir}`);
console.log(`App server: http://127.0.0.1:${serverPort}/`);
if (options.remoteDebuggingPort !== undefined) {
  console.log(`Chromium DevTools: http://127.0.0.1:${options.remoteDebuggingPort}/`);
}
console.log(`Native service label: ${serviceLabel}`);
console.log(`Native systemd unit: ${systemdUnit}`);
console.log(options.keepInstall ? "Install/package cleanup: disabled" : "Install/package cleanup: on exit");
console.log(options.keepService ? "Native test service cleanup: disabled" : "Native test service cleanup: on exit");
console.log("Quit Butler from the app/tray, or press Ctrl-C here to stop.");

const electronArgs = [`--user-data-dir=${electronProfileDir}`];
if (options.remoteDebuggingPort !== undefined) {
  electronArgs.push(`--remote-debugging-port=${options.remoteDebuggingPort}`);
}
const appProcess = spawn(executable, electronArgs, {
  cwd: dirname(executable),
  env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopChild(appProcess);
  });
}

try {
  await waitForLaunch(appProcess);
  console.log("Ready.");
} catch (error) {
  stopChild(appProcess);
  if (!options.keepService) cleanupNativeService({ serviceLabel, systemdUnit });
  if (!options.keepInstall) rmSync(packageWorkDir, { recursive: true, force: true });
  await waitForPortClear(serverPort);
  throw error;
}

const exitCode = await new Promise<number>((resolveExit) => {
  appProcess.once("exit", (code, signal) => {
    if (code !== null) {
      resolveExit(code);
      return;
    }
    resolveExit(signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1);
  });
});

if (!options.keepService) {
  cleanupNativeService({ serviceLabel, systemdUnit });
  await waitForPortClear(serverPort);
}
if (!options.keepInstall) {
  rmSync(installedRoot, { recursive: true, force: true });
  rmSync(packageWorkDir, { recursive: true, force: true });
}
if (options.cleanOnExit) {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(electronProfileDir, { recursive: true, force: true });
}
process.exit(exitCode);
