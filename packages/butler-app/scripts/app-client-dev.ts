import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnSyncReturns,
} from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

const root = process.cwd();
const dataRoot = resolve(process.env.BUTLER_DATA || resolve(homedir(), ".butler"));
const electronAppRoot = "packages/butler-app/client/electron";
const appDisplayName = "Butler";
const macDevBundleIdentifier = "com.hexpy.butler.dev";
const macDevBundleName = "Butler.app";
const macDevExecutableName = "Butler";
const macDevExecutableRelativePath = "Contents/MacOS/Butler";
const appIconRelativePath = "assets/butler.icns";
const appIconResourcePath = "Contents/Resources/butler.icns";
const uiPort = numberFromEnv("BUTLER_APP_UI_PORT", 5173);
const serverPort = numberFromEnv("BUTLER_APP_SERVER_PORT", 18765);
const uiUrl = process.env.BUTLER_APP_UI_URL ?? `http://127.0.0.1:${uiPort}`;
const serverUrl = normalizeLocalHttpUrl(
  process.env.BUTLER_APP_SERVER_URL ?? `http://127.0.0.1:${serverPort}`,
  "Butler app server URL",
);
const children = new Set<ChildProcess>();

type ElectronLaunch = {
  command: string;
  args: string[];
};

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function normalizeLocalHttpUrl(value: string, label: string): string {
  const url = new URL(value);
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  const local =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (url.protocol !== "http:" || !local) {
    throw new Error(`${label} must be a local http origin.`);
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function spawnManaged(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = root,
): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function readOptionalText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function fileFingerprint(path: string): string {
  const stat = statSync(path);
  return `${stat.size}:${stat.mtimeMs}`;
}

function describeSpawnFailure(result: SpawnSyncReturns<string>): string {
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
}

function runChecked(command: string, args: string[], action: string): void {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`Failed to ${action}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = describeSpawnFailure(result);
    throw new Error(
      `Failed to ${action}: ${detail || `${command} exited with ${result.status}`}`,
    );
  }
}

function setPlistString(plistPath: string, key: string, value: string): void {
  const plistBuddy = "/usr/libexec/PlistBuddy";
  const setResult = spawnSync(
    plistBuddy,
    ["-c", `Set :${key} ${value}`, plistPath],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  if (!setResult.error && setResult.status === 0) return;

  const addResult = spawnSync(
    plistBuddy,
    ["-c", `Add :${key} string ${value}`, plistPath],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  if (addResult.error) {
    throw new Error(`Failed to set ${key}: ${addResult.error.message}`);
  }
  if (addResult.status !== 0) {
    const detail =
      describeSpawnFailure(addResult) || describeSpawnFailure(setResult);
    throw new Error(
      `Failed to set ${key}: ${detail || `${plistBuddy} exited with ${addResult.status}`}`,
    );
  }
}

function prepareMacDevElectronBundle(): ElectronLaunch {
  const electronDistRoot = resolve(
    root,
    electronAppRoot,
    "node_modules/electron/dist",
  );
  const sourceBundle = resolve(electronDistRoot, "Electron.app");
  const sourceExecutable = resolve(sourceBundle, "Contents/MacOS/Electron");
  const sourceIcon = resolve(root, electronAppRoot, appIconRelativePath);
  const targetBundle = resolve(dataRoot, "cache/app-client-dev", macDevBundleName);
  const targetPlist = resolve(targetBundle, "Contents/Info.plist");
  const targetExecutable = resolve(targetBundle, macDevExecutableRelativePath);
  const targetIcon = resolve(targetBundle, appIconResourcePath);
  const markerPath = resolve(dataRoot, "cache/app-client-dev/.bundle-marker");
  if (!existsSync(sourceIcon)) {
    throw new Error(`Butler app icon is missing: ${appIconRelativePath}`);
  }
  const electronVersion = readOptionalText(
    resolve(electronDistRoot, "version"),
  )?.trim();
  const marker = [
    electronVersion || "unknown-electron-version",
    appDisplayName,
    macDevBundleIdentifier,
    targetExecutable,
    fileFingerprint(sourceIcon),
  ].join("\n");

  if (
    existsSync(targetExecutable) &&
    existsSync(targetPlist) &&
    existsSync(targetIcon) &&
    readOptionalText(markerPath) === `${marker}\n`
  ) {
    return {
      command: targetExecutable,
      args: [resolve(root, electronAppRoot)],
    };
  }

  if (!existsSync(sourceBundle) || !existsSync(sourceExecutable)) {
    throw new Error(
      "Electron app bundle is missing; run npm --prefix packages/butler-app/client/electron install first",
    );
  }
  rmSync(targetBundle, { recursive: true, force: true });
  mkdirSync(dirname(targetBundle), { recursive: true });
  runChecked(
    "/usr/bin/ditto",
    [sourceBundle, targetBundle],
    "copy Electron app bundle",
  );
  renameSync(
    resolve(targetBundle, "Contents/MacOS/Electron"),
    targetExecutable,
  );
  cpSync(sourceIcon, targetIcon, { recursive: true });
  chmodSync(targetExecutable, 0o755);
  setPlistString(targetPlist, "CFBundleDisplayName", appDisplayName);
  setPlistString(targetPlist, "CFBundleName", appDisplayName);
  setPlistString(targetPlist, "CFBundleExecutable", macDevExecutableName);
  setPlistString(targetPlist, "CFBundleIdentifier", macDevBundleIdentifier);
  setPlistString(targetPlist, "CFBundleIconFile", "butler.icns");
  setPlistString(targetPlist, "CFBundleIconName", "butler");
  runChecked(
    "/usr/bin/codesign",
    ["--force", "--deep", "--sign", "-", targetBundle],
    "sign Butler development app bundle",
  );
  writeFileSync(markerPath, `${marker}\n`);

  return { command: targetExecutable, args: [resolve(root, electronAppRoot)] };
}

function electronLaunchCommand(): ElectronLaunch {
  if (process.platform === "darwin") return prepareMacDevElectronBundle();
  return {
    command: "npm",
    args: ["--prefix", resolve(root, electronAppRoot), "run", "start"],
  };
}

async function waitForHttp(url: string, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until the dev server is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function stopAll(): void {
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 1500).unref();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopAll();
    process.exit(0);
  });
}

const vite = spawnManaged("npm", [
  "--prefix",
  "packages/butler-app/client/ui",
  "run",
  "dev",
  "--",
  "--host",
  "127.0.0.1",
  "--port",
  String(uiPort),
  "--strictPort",
]);

try {
  await waitForHttp(uiUrl);
  await waitForHttp(new URL("/health", serverUrl).toString());
  const electronLaunch = electronLaunchCommand();
  const electron = spawnManaged(electronLaunch.command, electronLaunch.args, {
    ...process.env,
    BUTLER_APP_SERVER_PORT: String(serverPort),
    BUTLER_APP_SERVER_URL: serverUrl,
    BUTLER_APP_UI_URL: uiUrl,
    BUTLER_APP_DEV_ORIGIN: new URL(uiUrl).origin,
  }, dataRoot);
  electron.once("exit", (code) => {
    stopAll();
    process.exit(code ?? 0);
  });
} catch (error) {
  stopAll();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

vite.once("exit", (code) => {
  stopAll();
  process.exit(code ?? 1);
});
