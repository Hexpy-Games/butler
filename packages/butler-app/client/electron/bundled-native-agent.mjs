import { constants, accessSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

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
    detached: true,
    foregroundHost: true,
    containmentKind: "posix_process_group",
    containmentVerified: true,
    ownerDeathGuaranteed: false,
    recordsProcessGroupId: true,
    env: {
      ...installation.env,
      BUTLER_APP_FOREGROUND_LEASE: "1",
    },
  };
}

export function resolveBundledNativeAgentInstallation({
  butlerData,
  resourcesPath = process.resourcesPath,
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  if (!resourcesPath) return null;
  const payloadRoot = join(resourcesPath, "bundled-agent");
  if (!existsSync(payloadRoot)) return null;
  if (platform === "win32") {
    throw new Error("Bundled native Agent host is not available on Windows.");
  }
  const binary = join(payloadRoot, "bin", "butler-agent");
  const resourceRoot = join(payloadRoot, "resources");
  requireFile(binary, "Bundled native Agent executable is missing.");
  requireDirectory(resourceRoot, "Bundled native Agent resources are missing.");
  accessSync(binary, constants.X_OK);

  const installationRoot = platform === "darwin"
    ? macAppRoot(execPath)
    : dirname(resolve(execPath));
  requireInside(installationRoot, binary);
  requireInside(installationRoot, resourceRoot);
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
    return installation;
  }
  const configured = env.BUTLER_NATIVE_AGENT_EXECUTABLE?.trim();
  if (!configured || !isAbsolute(configured)) {
    throw new Error("Development Butler App requires an absolute BUTLER_NATIVE_AGENT_EXECUTABLE path.");
  }
  const configuredBinary = resolve(configured);
  requireFile(configuredBinary, "Native Agent executable is missing.");
  const binary = realpathSync(configuredBinary);
  accessSync(binary, constants.X_OK);
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
