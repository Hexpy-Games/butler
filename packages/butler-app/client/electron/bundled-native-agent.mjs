import { constants, accessSync, linkSync, rmSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { processRoleFileNames } from "./scripts/process-role-names.mjs";
import { preferNewerAgent, resolveCliInstalledAgent } from "./cli-installed-native-agent.mjs";

const manifestName = "native-agent-manifest.json";

export function resolveBundledNativeAgentCommand({
  butlerData,
  resourcesPath = process.resourcesPath,
  execPath = process.execPath,
  platform = process.platform,
  isPackaged = true,
  env = process.env,
} = {}) {
  const installation = resolveNativeAgentInstallation({
    butlerData,
    resourcesPath,
    execPath,
    platform,
    isPackaged,
    env,
  });
  return {
    ...installation,
    stdio: ["pipe", "inherit", "inherit"],
    detached: platform !== "win32",
    foregroundHost: true,
    containmentKind: platform === "win32" ? "direct_child" : "posix_process_group",
    containmentVerified: true,
    ownerDeathGuaranteed: false,
    recordsProcessGroupId: platform !== "win32",
    env: {
      ...installation.env,
      BUTLER_APP_FOREGROUND_LEASE: "1",
      BUTLER_APP_QUIT_WAIT_SAFELY: "1",
      BUTLER_SHUTDOWN_TRACE: "1",
    },
  };
}

export function resolveBundledNativeAgentInstallation({
  butlerData,
  resourcesPath = process.resourcesPath,
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  if (platform === "win32") resourcesPath = join(dirname(resolve(execPath)), "resources");
  if (!resourcesPath) return null;
  const payloadRoot = join(resourcesPath, "bundled-agent");
  if (!existsSync(payloadRoot)) return null;
  const binary = join(payloadRoot, "bin", platform === "win32" ? "butler-agent.exe" : "butler-agent");
  const resourceRoot = join(payloadRoot, "resources");
  requireFile(binary, "Bundled native Agent executable is missing.");
  requireDirectory(resourceRoot, "Bundled native Agent resources are missing.");
  if (platform !== "win32") accessSync(binary, constants.X_OK);

  const installationRoot = platform === "darwin"
    ? macAppRoot(execPath)
    : dirname(resolve(execPath));
  requireInside(installationRoot, binary);
  requireInside(installationRoot, resourceRoot);
  if (platform === "win32") restoreWindowsRoleLinks(binary);
  return {
    command: binary,
    args: [
      "--installation-root",
      installationRoot,
      "--resource-root",
      resourceRoot,
    ],
    cwd: butlerData,
    appManaged: true,
    bundledAgentVersion: readVersion(payloadRoot),
    env: { BUTLER_DATA: butlerData },
  };
}

export function resolveNativeAgentInstallation({
  butlerData,
  resourcesPath = process.resourcesPath,
  execPath = process.execPath,
  platform = process.platform,
  isPackaged = true,
  env = process.env,
} = {}) {
  if (isPackaged) {
    const installation = resolveBundledNativeAgentInstallation({
      butlerData, resourcesPath, execPath, platform,
    });
    if (!installation) throw new Error("Packaged Butler App is missing bundled native Agent resources.");
    // A newer CLI-installed Agent (AGENT_HOME/current) wins over the bundled one.
    return preferNewerAgent(installation, resolveCliInstalledAgent({ butlerData, platform, env }));
  }
  const configured = env.BUTLER_NATIVE_AGENT_EXECUTABLE?.trim();
  if (!configured || !isAbsolute(configured)) {
    throw new Error("Development Butler App requires an absolute BUTLER_NATIVE_AGENT_EXECUTABLE path.");
  }
  const configuredBinary = resolve(configured);
  requireFile(configuredBinary, "Native Agent executable is missing.");
  const binary = realpathSync(configuredBinary);
  if (platform !== "win32") accessSync(binary, constants.X_OK);
  const binaryDirectory = dirname(binary);
  const installationRoot = basename(binaryDirectory) === "bin"
    ? dirname(binaryDirectory)
    : binaryDirectory;
  const resourceRoot = join(installationRoot, "resources");
  requireDirectory(resourceRoot, "Native Agent resources are missing beside the executable.");
  requireInside(installationRoot, binary);
  requireInside(installationRoot, resourceRoot);
  return {
    command: binary,
    args: ["--installation-root", installationRoot, "--resource-root", resourceRoot],
    cwd: butlerData,
    appManaged: true,
    bundledAgentVersion: readVersion(installationRoot),
    env: { BUTLER_DATA: butlerData },
  };
}

function macAppRoot(execPath) {
  let current = resolve(execPath);
  while (dirname(current) !== current) {
    if (basename(current).endsWith(".app")) return current;
    current = dirname(current);
  }
  throw new Error("Bundled native Agent executable is not inside a macOS app bundle.");
}

function requireInside(root, child) {
  const path = relative(resolve(root), resolve(child));
  if (path === "" || path.startsWith("..") || path.startsWith("/")) {
    throw new Error("Bundled native Agent path escapes the application installation.");
  }
}

function requireFile(path, message) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(message);
}

function requireDirectory(path, message) {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(message);
}

function readVersion(payloadRoot) {
  try {
    const manifest = JSON.parse(readFileSync(join(payloadRoot, manifestName), "utf8"));
    return typeof manifest.version === "string" && manifest.version.trim()
      ? manifest.version.trim()
      : null;
  } catch {
    return null;
  }
}

// ZIP extraction materializes hardlinks as copies. Recreate the three NTFS
// aliases before spawning; Rust verifies file identity when executing a role.
function restoreWindowsRoleLinks(binary) {
  const source = statSync(binary, { bigint: true });
  for (const name of processRoleFileNames("win32")) {
    const alias = join(dirname(binary), name);
    if (existsSync(alias)) {
      const metadata = statSync(alias, { bigint: true });
      if (metadata.ino === source.ino && metadata.dev === source.dev) continue;
      rmSync(alias);
    }
    linkSync(binary, alias);
  }
}
