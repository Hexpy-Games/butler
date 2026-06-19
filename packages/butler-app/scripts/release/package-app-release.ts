#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  APP_RELEASE_PLATFORMS,
  createAppBackgroundServiceReleaseCapability,
  createAppDependencyClosureManifest,
  createAppDesktopHelperMetadata,
  createAppReleaseManifest,
  validateAppDependencyClosureManifest,
  validateAppReleaseManifest,
  type AppReleaseManifest,
  type AppReleasePlatform,
} from "./manifest.ts";

export interface AppReleasePackageOptions {
  root: string;
  outDir: string;
  artifactBaseUrl?: string | null;
  platforms?: AppReleasePlatform[];
  linuxPackageFormat?: LinuxAppPackageFormat;
}

export interface AppReleasePackageArtifact {
  platform: AppReleasePlatform;
  artifactName: string;
  artifactPath: string;
  sha256Path: string;
  sha256: string;
}

export interface AppReleasePackageResult {
  artifacts: AppReleasePackageArtifact[];
  releaseManifestPath: string;
  updateManifestPath: string;
  version: string;
}

export interface BundledAgentResource {
  resourceDir: string;
  artifactName: string;
  sha256: string;
  version: string;
  platform: AppReleasePlatform;
}

export interface BundledAgentPackage {
  artifactPath: string;
  releaseManifestPath: string;
  updateManifestPath: string;
  artifactName: string;
  sha256: string;
  version: string;
}

type LinuxAppPackageFormat = "deb" | "pacman";

const ELECTRON_ROOT = join("packages", "butler-app", "client", "electron");
const APP_RENDERER_DIST = join("packages", "butler-app", "client", "ui", "dist");
const MAC_SIGN_SCRIPT = join(ELECTRON_ROOT, "scripts", "adhoc-sign-mac.mjs");
const MAC_NORMALIZE_SCRIPT = join(ELECTRON_ROOT, "scripts", "normalize-mac-bundle.mjs");
const MAC_APP_BUNDLE_IDENTIFIER = "com.hexpy.butler";
const MAC_HELPER_BUNDLE_IDENTIFIER = "com.hexpy.butler.helper";
const MAC_APP_ICON_RESOURCE = join("Contents", "Resources", "butler.icns");

export function appReleaseIconPath(root: string): string {
  return join(resolve(root), ELECTRON_ROOT, "assets", "butler.icns");
}

export function appReleasePackagerIconPath(outDir: string): string {
  return join(resolve(outDir), "butler-release-icon.icns");
}

export function createAppReleasePackage(
  options: AppReleasePackageOptions,
): AppReleasePackageResult {
  const root = resolve(options.root);
  const outDir = resolve(options.outDir);
  const manifest = createAppReleaseManifest(root);
  const issues = validateAppReleaseManifest(root, manifest);
  if (issues.length > 0) {
    throw new Error(`app release manifest is invalid: ${issues.join("; ")}`);
  }
  const platforms = options.platforms ?? [...APP_RELEASE_PLATFORMS];
  assertSupportedPlatforms(platforms);
  if (platforms.length === 0) {
    throw new Error("at least one app release platform is required");
  }
  mkdirSync(outDir, { recursive: true });

  const workDir = mkdtempSync(join(tmpdir(), "butler-app-release-"));
  try {
    const bundledAgentPackage = createAgentReleasePackage({
      root,
      outDir: join(workDir, "agent-release"),
      artifactBaseUrl: "bundled-agent",
      dependencyTarget: dependencyTargetForAppPlatforms(platforms),
    });
    const bundledAgents = new Map(platforms.map((platform) => [
      platform,
      prepareBundledAgentResourceFromPackage(
        root,
        workDir,
        platform,
        bundledAgentPackage,
        manifest.version,
      ),
    ]));
    const artifacts = platforms.map((platform) =>
      packagePlatform({
        root,
        outDir,
        workDir,
        platform,
        manifest,
        linuxPackageFormat: options.linuxPackageFormat ?? "deb",
        bundledAgentResourceDir: mustGetBundledAgentResource(bundledAgents, platform).resourceDir,
      }),
    );
    const bundledAgent = mustGetBundledAgentResource(bundledAgents, platforms[0]);
    const releaseManifest = withArtifactMetadata(
      withBundledAgentMetadata(manifest, bundledAgent),
      artifacts,
      options.artifactBaseUrl,
    );
    const releaseManifestPath = join(outDir, "app-release-manifest.json");
    writeJson(releaseManifestPath, releaseManifest);

    const updateManifestPath = join(outDir, "app-update-manifest.json");
    writeJson(updateManifestPath, createAppUpdateManifest(releaseManifest));

    return {
      artifacts,
      releaseManifestPath,
      updateManifestPath,
      version: manifest.version,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function packagePlatform(input: {
  root: string;
  outDir: string;
  workDir: string;
  platform: AppReleasePlatform;
  manifest: AppReleaseManifest;
  linuxPackageFormat: LinuxAppPackageFormat;
  bundledAgentResourceDir: string;
}): AppReleasePackageArtifact {
  if (input.platform === "darwin-arm64" && process.platform !== "darwin") {
    throw new Error("darwin-arm64 app releases must be packaged on macOS for signing");
  }
  const artifact = input.manifest.artifacts.find(
    (item) => item.platform === input.platform,
  );
  if (!artifact) throw new Error(`missing app artifact definition: ${input.platform}`);

  const packageOut = join(input.workDir, input.platform);
  mkdirSync(packageOut, { recursive: true });
  runElectronPackager(
    input.root,
    packageOut,
    input.platform,
    input.bundledAgentResourceDir,
  );
  const packagedDir = join(packageOut, packageDirectoryName(input.platform));
  if (!existsSync(packagedDir)) {
    throw new Error(`electron package directory was not created: ${packagedDir}`);
  }

  const artifactName = appPackageArtifactName({
    defaultArtifactName: artifact.artifactName,
    platform: input.platform,
    version: input.manifest.version,
    linuxPackageFormat: input.linuxPackageFormat,
  });
  const artifactPath = join(input.outDir, artifactName);
  if (input.platform === "darwin-arm64") {
    const appBundle = join(packagedDir, "Butler.app");
    if (!existsSync(appBundle)) throw new Error(`mac app bundle not found: ${appBundle}`);
    normalizeMacBundle(input.root, appBundle);
    verifyMacBundleIcon(input.root, appBundle);
    signMacBundle(input.root, appBundle);
    createMacPkg({
      appBundle,
      artifactPath,
      bundledAgentResourceDir: input.bundledAgentResourceDir,
      version: input.manifest.version,
    });
  } else if (input.linuxPackageFormat === "deb") {
    createLinuxAppDeb({
      artifactPath,
      root: input.root,
      packagedDir,
      platform: input.platform,
      version: input.manifest.version,
    });
  } else {
    createLinuxAppPacman({
      artifactPath,
      root: input.root,
      packagedDir,
      platform: input.platform,
      version: input.manifest.version,
    });
  }

  const sha256 = sha256File(artifactPath);
  const sha256Path = `${artifactPath}.sha256`;
  writeFileSync(sha256Path, `${sha256}  ${basename(artifactPath)}\n`, "utf8");
  return {
    platform: input.platform,
    artifactName,
    artifactPath,
    sha256Path,
    sha256,
  };
}

function appPackageArtifactName(input: {
  defaultArtifactName: string;
  platform: AppReleasePlatform;
  version: string;
  linuxPackageFormat: LinuxAppPackageFormat;
}): string {
  if (!input.platform.startsWith("linux-") || input.linuxPackageFormat === "deb") {
    return input.defaultArtifactName;
  }
  if (input.platform !== "linux-x64") {
    throw new Error("pacman App packages currently support linux-x64 only");
  }
  return `butler-app-${input.version}-1-x86_64.pkg.tar.zst`;
}

function runElectronPackager(
  root: string,
  outDir: string,
  platform: AppReleasePlatform,
  bundledAgentResourceDir: string,
): void {
  const packager = process.env.BUTLER_APP_PACKAGER ||
    join(root, ELECTRON_ROOT, "node_modules", ".bin", "electron-packager");
  if (!existsSync(packager)) {
    throw new Error(
      "Electron packager is missing; run npm --prefix packages/butler-app/client/electron ci",
    );
  }
  const iconPath = appReleaseIconPath(root);
  if (!existsSync(iconPath)) {
    throw new Error(`Butler app icon is missing: ${iconPath}`);
  }
  const rendererDist = join(root, APP_RENDERER_DIST);
  if (!existsSync(join(rendererDist, "index.html"))) {
    throw new Error(`Butler app renderer dist is missing: ${rendererDist}`);
  }
  const rendererResourceDir = join(outDir, "app-client");
  rmSync(rendererResourceDir, { recursive: true, force: true });
  cpSync(rendererDist, rendererResourceDir, {
    dereference: false,
    errorOnExist: false,
    force: true,
    recursive: true,
  });
  const packagerIconPath = appReleasePackagerIconPath(outDir);
  copyFileSync(iconPath, packagerIconPath);
  const [electronPlatform, electronArch] = platform.split("-");
  const result = spawnSync(packager, [
    join(root, ELECTRON_ROOT),
    "Butler",
    `--platform=${electronPlatform}`,
    `--arch=${electronArch}`,
    "--overwrite",
    `--out=${outDir}`,
    `--icon=${packagerIconPath}`,
    `--app-bundle-id=${MAC_APP_BUNDLE_IDENTIFIER}`,
    `--helper-bundle-id=${MAC_HELPER_BUNDLE_IDENTIFIER}`,
    `--extra-resource=${bundledAgentResourceDir}`,
    `--extra-resource=${rendererResourceDir}`,
    "--ignore=^/dist($|/)",
    "--quiet",
  ], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `electron package failed for ${platform}: ${
        result.stderr.trim() || result.stdout.trim() || "unknown error"
      }`,
    );
  }
}

export function prepareBundledAgentResource(
  root: string,
  workDir: string,
  platform: AppReleasePlatform = currentHostAppReleasePlatform(),
): BundledAgentResource {
  const manifest = createAppReleaseManifest(root);
  const agentOutDir = join(workDir, "agent-release");
  const agent = createAgentReleasePackage({
    root,
    outDir: agentOutDir,
    artifactBaseUrl: "bundled-agent",
  });
  return prepareBundledAgentResourceFromPackage(root, workDir, platform, agent, manifest.version);
}

export function prepareBundledAgentResourceFromPackage(
  root: string,
  workDir: string,
  platform: AppReleasePlatform,
  agent: BundledAgentPackage,
  appVersion: string,
): BundledAgentResource {
  const resourceDir = join(workDir, platform, "bundled-agent");
  mkdirSync(resourceDir, { recursive: true });
  copyFileSync(agent.artifactPath, join(resourceDir, agent.artifactName));
  copyFileSync(agent.releaseManifestPath, join(resourceDir, "agent-release-manifest.json"));
  copyFileSync(agent.updateManifestPath, join(resourceDir, "agent-update-manifest.json"));
  cpSync(
    join(root, "packages", "butler-agent", "resources", "runtime"),
    join(resourceDir, "runtime"),
    { recursive: true },
  );
  copyManagedRuntimeExecutable(join(resourceDir, "runtime"), platform);
  writeJson(
    join(resourceDir, "background-service-capability.json"),
    createAppBackgroundServiceReleaseCapability([platform]),
  );
  writeJson(
    join(resourceDir, "background-service-registration.json"),
    createAppBackgroundServiceRegistrationMetadata(platform),
  );
  writeAppServiceInstallerPayloads({
    resourceDir,
    platform,
    appVersion,
  });
  const releaseManifestSha256 = sha256File(join(resourceDir, "agent-release-manifest.json"));
  const updateManifestSha256 = sha256File(join(resourceDir, "agent-update-manifest.json"));
  const backgroundServiceCapabilitySha256 = sha256File(
    join(resourceDir, "background-service-capability.json"),
  );
  const backgroundServiceRegistrationSha256 = sha256File(join(
    resourceDir,
    "background-service-registration.json",
  ));
  const backgroundServiceInstallerPayloadSha256 = sha256Directory(
    join(resourceDir, "service-installer"),
  );
  const backgroundServiceRegistrationMetadataSha256 = sha256Values([
    backgroundServiceCapabilitySha256,
    backgroundServiceRegistrationSha256,
    backgroundServiceInstallerPayloadSha256,
  ]);
  const managedRuntimeSha256 = sha256Directory(join(resourceDir, "runtime"));
  const dependencyClosure = createAppDependencyClosureManifest({
    bundledAgentVersion: agent.version,
    bundledAgentArtifactName: agent.artifactName,
    bundledAgentSha256: agent.sha256,
    releaseManifestSha256,
    updateManifestSha256,
    managedRuntimeSha256,
    backgroundServiceRegistrationMetadataSha256,
    releaseManifestsSha256: sha256Values([releaseManifestSha256, updateManifestSha256]),
    runtimePackageDependenciesSha256: sha256Values([agent.sha256, managedRuntimeSha256]),
    repairSourceSha256: sha256Values([
      agent.sha256,
      releaseManifestSha256,
      updateManifestSha256,
      managedRuntimeSha256,
      backgroundServiceRegistrationMetadataSha256,
    ]),
  });
  const dependencyClosureIssues = validateAppDependencyClosureManifest(dependencyClosure);
  if (dependencyClosureIssues.length > 0) {
    throw new Error(
      `app dependency closure manifest is invalid: ${dependencyClosureIssues.join("; ")}`,
    );
  }
  writeJson(join(resourceDir, "dependency-closure.json"), dependencyClosure);
  return {
    resourceDir,
    artifactName: agent.artifactName,
    sha256: agent.sha256,
    version: agent.version,
    platform,
  };
}

function writeAppServiceInstallerPayloads(input: {
  resourceDir: string;
  platform: AppReleasePlatform;
  appVersion: string;
}): void {
  const capability = createAppBackgroundServiceReleaseCapability([input.platform]);
  const requirement = capability.installerRequirements[0];
  if (!requirement) {
    throw new Error(`missing background service installer requirement for ${input.platform}`);
  }
  if (requirement.platform === "darwin") {
    writeJson(
      join(input.resourceDir, "service-installer", "darwin", "launchd", "render-contract.json"),
      serviceRenderContract({
        platform: "darwin",
        manager: "launchd",
        target: "$HOME/Library/LaunchAgents/com.hexpy.butler.plist",
        escaping: "xml",
      }),
    );
    writeExecutableText(
      join(input.resourceDir, "service-installer", "darwin", "pkg", "postinstall"),
      macPkgPostinstallScript(),
    );
    writeServiceInstallerManifest({
      resourceDir: input.resourceDir,
      releasePlatform: input.platform,
      servicePlatform: "darwin",
      packageArtifacts: [
        {
          packageFormat: "pkg",
          selectedV1Path: "macos-pkg-launch-agent",
          serviceManager: "launchd",
          serviceDefinitionTarget: "$HOME/Library/LaunchAgents/com.hexpy.butler.plist",
          renderContractPath: "service-installer/darwin/launchd/render-contract.json",
          postInstallPath: "service-installer/darwin/pkg/postinstall",
        },
      ],
    });
    return;
  }
  if (requirement.platform === "linux") {
    writeJson(
      join(input.resourceDir, "service-installer", "linux", "systemd", "render-contract.json"),
      serviceRenderContract({
        platform: "linux",
        manager: "systemd-user",
        target: "/usr/lib/systemd/user/butler.service",
        escaping: "systemd-quoted",
      }),
    );
    writeExecutableText(
      join(input.resourceDir, "service-installer", "linux", "deb", "postinst"),
      linuxDebPostinstScript(),
    );
    writeExecutableText(
      join(input.resourceDir, "service-installer", "linux", "rpm", "postinstall.sh"),
      linuxRpmPostinstallScript(),
    );
    writeExecutableText(
      join(input.resourceDir, "service-installer", "linux", "pacman", "post_install"),
      linuxPacmanPostInstallScript(),
    );
    writeExecutableText(
      join(
        input.resourceDir,
        "service-installer",
        "linux",
        "launcher",
        "butler-app-managed-agent-service",
      ),
      linuxAppManagedAgentServiceLauncher(input.appVersion),
    );
    writeServiceInstallerManifest({
      resourceDir: input.resourceDir,
      releasePlatform: input.platform,
      servicePlatform: "linux",
      packageArtifacts: [
        {
          packageFormat: "deb",
          selectedV1Path: "linux-deb-owned-user-unit",
          serviceManager: "systemd-user",
          serviceDefinitionTarget: "/usr/lib/systemd/user/butler.service",
          renderContractPath: "service-installer/linux/systemd/render-contract.json",
          launcherPath: "service-installer/linux/launcher/butler-app-managed-agent-service",
          postInstallPath: "service-installer/linux/deb/postinst",
        },
        {
          packageFormat: "pacman",
          selectedV1Path: "linux-pacman-owned-user-unit",
          serviceManager: "systemd-user",
          serviceDefinitionTarget: "/usr/lib/systemd/user/butler.service",
          renderContractPath: "service-installer/linux/systemd/render-contract.json",
          launcherPath: "service-installer/linux/launcher/butler-app-managed-agent-service",
          postInstallPath: "service-installer/linux/pacman/post_install",
        },
        {
          packageFormat: "rpm",
          selectedV1Path: "linux-rpm-owned-user-unit",
          serviceManager: "systemd-user",
          serviceDefinitionTarget: "/usr/lib/systemd/user/butler.service",
          renderContractPath: "service-installer/linux/systemd/render-contract.json",
          launcherPath: "service-installer/linux/launcher/butler-app-managed-agent-service",
          postInstallPath: "service-installer/linux/rpm/postinstall.sh",
        },
      ],
    });
    return;
  }
  throw new Error(`unsupported background service installer payload platform: ${requirement.platform}`);
}

function writeServiceInstallerManifest(input: {
  resourceDir: string;
  releasePlatform: AppReleasePlatform;
  servicePlatform: "darwin" | "linux";
  packageArtifacts: Array<Record<string, string>>;
}): void {
  writeJson(
    join(input.resourceDir, "service-installer", "installer-manifest.json"),
    {
      schema: "butler.app-service-installer-bundle.v1",
      product: "butler-app",
      releasePlatform: input.releasePlatform,
      servicePlatform: input.servicePlatform,
      gatewayProfile: "electron",
      renderer: "butler-app-native-service-bridge",
      hostToolsRequiredForFirstLaunch: [],
      packageArtifacts: input.packageArtifacts,
      rawTemplateIncluded: false,
      rawTextIncluded: false,
    },
  );
}

function serviceRenderContract(input: {
  platform: "darwin" | "linux";
  manager: "launchd" | "systemd-user";
  target: string;
  escaping: "xml" | "systemd-quoted";
}): Record<string, unknown> {
  return {
    schema: "butler.app-service-render-contract.v1",
    platform: input.platform,
    manager: input.manager,
    target: input.target,
    renderer: "butler-app-native-service-bridge",
    requiredEscaping: input.escaping,
    launcherPath: input.platform === "linux"
      ? "/usr/lib/butler/butler-app-managed-agent-service"
      : null,
    label: "com.hexpy.butler",
    unit: input.platform === "linux" ? "butler.service" : null,
    requiredEnvironment: [
      "BUTLER_HOME",
      "BUTLER_DATA",
      "BUTLER_BUN",
      "BUTLER_APP_MANAGED_RUNTIME_POINTER",
      "BUTLER_APP_MANAGED_RUNTIME_HOME",
      "BUTLER_APP_SERVER_HOST",
      "BUTLER_APP_SERVER_PORT",
      "BUTLER_APP_GATEWAY_PID_FILE",
      "BUTLER_APP_LOCAL_AUTH_REQUIRED",
      "BUTLER_APP_LOCAL_AUTH_FILE",
    ],
    rawTemplateIncluded: false,
    rawTextIncluded: false,
  };
}

function macPkgPostinstallScript(): string {
  return `#!/bin/sh
set -eu
echo "Butler App LaunchAgent payload installed. First-run will render user paths and bootstrap the service."
exit 0
`;
}

function linuxDebPostinstScript(): string {
  return `#!/bin/sh
set -eu
echo "Butler App systemd user service payload installed. First-run will render user paths and enable the service."
exit 0
`;
}

function linuxRpmPostinstallScript(): string {
  return `#!/bin/sh
set -eu
echo "Butler App systemd user service payload installed. First-run will render user paths and enable the service."
exit 0
`;
}

function linuxPacmanPostInstallScript(): string {
  return `#!/bin/sh
set -eu
echo "Butler App systemd user service payload installed. First-run will render user paths and enable the service."
exit 0
`;
}

function linuxAppManagedAgentServiceLauncher(version: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

BUTLER_DATA="\${BUTLER_DATA:-$HOME/.butler}"
POINTER="$BUTLER_DATA/app/runtime/agent/current.json"
AUTH_FILE="\${BUTLER_APP_LOCAL_AUTH_FILE:-$BUTLER_DATA/app/runtime/auth/local-agent-auth.json}"
PORT="\${BUTLER_APP_SERVER_PORT:-18765}"

if [ ! -f "$POINTER" ]; then
  echo "Butler App-managed Agent runtime pointer is missing: $POINTER" >&2
  exit 1
fi

RUNTIME_HOME_REL="$(sed -n 's/.*"runtime_home"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$POINTER" | head -n 1)"
case "$RUNTIME_HOME_REL" in
  ""|/*|..|../*|*/..|*/../*)
    echo "Butler App-managed Agent runtime pointer is invalid." >&2
    exit 1
    ;;
esac
RUNTIME_HOME="$BUTLER_DATA/$RUNTIME_HOME_REL"
SERVICE_DAEMON="$RUNTIME_HOME/packages/butler-agent/scripts/service-daemon.sh"
BUTLER_BUN="$RUNTIME_HOME/packages/butler-agent/resources/runtime/bin/bun"

if [ ! -x "$BUTLER_BUN" ] || [ ! -f "$SERVICE_DAEMON" ]; then
  echo "Butler App-managed Agent runtime is not ready." >&2
  exit 1
fi

export BUTLER_HOME="$RUNTIME_HOME"
export BUTLER_DATA
export BUTLER_BUN
export BUTLER_APP_MANAGED_RUNTIME_POINTER="$POINTER"
export BUTLER_APP_MANAGED_RUNTIME_HOME="$RUNTIME_HOME"
export BUTLER_APP_SERVER_HOST="\${BUTLER_APP_SERVER_HOST:-127.0.0.1}"
export BUTLER_APP_SERVER_PORT="$PORT"
export BUTLER_APP_GATEWAY_PID_FILE="\${BUTLER_APP_GATEWAY_PID_FILE:-off}"
export BUTLER_APP_LOCAL_AUTH_REQUIRED="\${BUTLER_APP_LOCAL_AUTH_REQUIRED:-1}"
export BUTLER_APP_LOCAL_AUTH_FILE="$AUTH_FILE"
export BUTLER_APP_VERSION="\${BUTLER_APP_VERSION:-${version}}"

exec /bin/bash "$SERVICE_DAEMON"
`;
}

function createAppBackgroundServiceRegistrationMetadata(
  platform: AppReleasePlatform,
): Record<string, unknown> {
  const capability = createAppBackgroundServiceReleaseCapability([platform]);
  const requirement = capability.installerRequirements[0];
  if (!requirement) {
    throw new Error(`missing background service installer requirement for ${platform}`);
  }
  return {
    schema: "butler.app-background-service-registration.v1",
    product: "butler-app",
    releasePlatform: platform,
    servicePlatform: requirement.platform,
    gatewayProfile: "electron",
    installerRequired: requirement.installerRequired,
    packageFormats: requirement.packageFormats,
    packageInstallerTargets: packageInstallerTargets(requirement.platform),
    registersUserService: requirement.registersUserService,
    runtimePointerPath: "$BUTLER_DATA/app/runtime/agent/current.json",
    runtimeHomeEnv: "BUTLER_APP_MANAGED_RUNTIME_HOME",
    localAuthPath: "$BUTLER_DATA/app/runtime/auth/local-agent-auth.json",
    serviceDefinition: serviceDefinitionMetadata(requirement.platform),
    desktopHelper: createAppDesktopHelperMetadata([platform]),
    requiredEnvironment: [
      "BUTLER_HOME",
      "BUTLER_DATA",
      "BUTLER_BUN",
      "BUTLER_APP_MANAGED_RUNTIME_POINTER",
      "BUTLER_APP_MANAGED_RUNTIME_HOME",
      "BUTLER_APP_SERVER_HOST",
      "BUTLER_APP_SERVER_PORT",
      "BUTLER_APP_GATEWAY_PID_FILE",
      "BUTLER_APP_LOCAL_AUTH_REQUIRED",
      "BUTLER_APP_LOCAL_AUTH_FILE",
    ],
    rawTextIncluded: false,
  };
}

function packageInstallerTargets(servicePlatform: string): Array<Record<string, string>> {
  if (servicePlatform === "darwin") {
    return [{ packageFormat: "pkg", selectedV1Path: "macos-pkg-launch-agent" }];
  }
  if (servicePlatform === "linux") {
    return [
      { packageFormat: "deb", selectedV1Path: "linux-deb-owned-user-unit" },
      { packageFormat: "pacman", selectedV1Path: "linux-pacman-owned-user-unit" },
      { packageFormat: "rpm", selectedV1Path: "linux-rpm-owned-user-unit" },
    ];
  }
  throw new Error(`unsupported background service installer target platform: ${servicePlatform}`);
}

function serviceDefinitionMetadata(servicePlatform: string): Record<string, unknown> {
  if (servicePlatform === "darwin") {
    return {
      manager: "launchd",
      label: "com.hexpy.butler",
      serviceFile: "$HOME/Library/LaunchAgents/com.hexpy.butler.plist",
      userDomain: "gui/$UID",
      installAction: "pkg-install-or-first-run-bootstrap",
      startAction: "launchctl kickstart -k gui/$UID/com.hexpy.butler",
      stopAction: "launchctl bootout gui/$UID/com.hexpy.butler",
    };
  }
  if (servicePlatform === "linux") {
    return {
      manager: "systemd-user",
      unit: "butler.service",
      serviceFile: "/usr/lib/systemd/user/butler.service",
      installAction: "package-owned-user-unit-or-first-run-enable",
      startAction: "systemctl --user start butler.service",
      stopAction: "systemctl --user stop butler.service",
    };
  }
  throw new Error(`unsupported background service registration platform: ${servicePlatform}`);
}

function copyManagedRuntimeExecutable(runtimeDir: string, platform: AppReleasePlatform): void {
  const source = managedRuntimeExecutableForPlatform(platform);
  if (!existsSync(source)) {
    throw new Error(`managed App runtime executable is missing: ${source}`);
  }
  assertManagedRuntimeExecutablePlatform(source, platform);
  const target = join(runtimeDir, "bin", "bun");
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  try {
    chmodSync(target, 0o755);
  } catch {
    // Preserve copy success on filesystems where chmod is not supported.
  }
}

function managedRuntimeExecutableForPlatform(platform: AppReleasePlatform): string {
  const platformEnv = `BUTLER_APP_MANAGED_BUN_${platformEnvSuffix(platform)}`;
  const explicit = process.env[platformEnv];
  if (explicit?.trim()) return explicit;
  if (platform === currentHostAppReleasePlatform()) {
    return process.env.BUTLER_APP_MANAGED_BUN || process.env.BUTLER_BUN || process.execPath;
  }
  throw new Error(`managed App runtime executable for ${platform} is missing; set ${platformEnv}`);
}

function assertManagedRuntimeExecutablePlatform(
  path: string,
  platform: AppReleasePlatform,
): void {
  const bytes = readFileSync(path);
  if (platform === "linux-x64" && isElfX64(bytes)) return;
  if (platform === "linux-arm64" && isElfArm64(bytes)) return;
  if (platform === "darwin-arm64" && isMachOArm64(bytes)) return;
  throw new Error(`managed App runtime executable does not match ${platform}: ${path}`);
}

function isElfX64(bytes: Buffer): boolean {
  if (
    bytes.length < 20 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46 ||
    bytes[4] !== 2
  ) {
    return false;
  }
  const machine = bytes[5] === 2
    ? bytes.readUInt16BE(18)
    : bytes.readUInt16LE(18);
  return machine === 0x3e;
}

function isElfArm64(bytes: Buffer): boolean {
  if (
    bytes.length < 20 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46 ||
    bytes[4] !== 2
  ) {
    return false;
  }
  const machine = bytes[5] === 2
    ? bytes.readUInt16BE(18)
    : bytes.readUInt16LE(18);
  return machine === 0xb7;
}

function isMachOArm64(bytes: Buffer): boolean {
  if (bytes.length < 8) return false;
  const arm64 = 0x0100000c;
  const magicLe = bytes.readUInt32LE(0);
  const magicBe = bytes.readUInt32BE(0);
  if (magicLe === 0xfeedfacf || magicLe === 0xfeedface) {
    return bytes.readInt32LE(4) === arm64;
  }
  if (magicBe === 0xfeedfacf || magicBe === 0xfeedface) {
    return bytes.readInt32BE(4) === arm64;
  }
  if (magicBe === 0xcafebabe || magicBe === 0xcafebabf) {
    const entrySize = magicBe === 0xcafebabf ? 32 : 20;
    const count = bytes.readUInt32BE(4);
    for (let index = 0; index < count; index += 1) {
      const offset = 8 + index * entrySize;
      if (offset + 4 <= bytes.length && bytes.readInt32BE(offset) === arm64) {
        return true;
      }
    }
  }
  return false;
}

function platformEnvSuffix(platform: AppReleasePlatform): string {
  return platform.toUpperCase().replace(/[^A-Z0-9]+/gu, "_");
}

function currentHostAppReleasePlatform(): AppReleasePlatform {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  throw new Error(
    "current host platform is not a supported App release runtime; set BUTLER_APP_MANAGED_BUN_<PLATFORM>",
  );
}

function createAgentReleasePackage(input: {
  root: string;
  outDir: string;
  artifactBaseUrl: string;
  dependencyTarget?: { os?: string; cpu?: string } | null;
}): BundledAgentPackage {
  const bun = process.env.BUTLER_BUN || "bun";
  const env = {
    ...process.env,
    ...(input.dependencyTarget?.os
      ? { BUTLER_AGENT_DEPENDENCY_OS: input.dependencyTarget.os }
      : {}),
    ...(input.dependencyTarget?.cpu
      ? { BUTLER_AGENT_DEPENDENCY_CPU: input.dependencyTarget.cpu }
      : {}),
  };
  const result = spawnSync(bun, [
    "run",
    "--silent",
    join("deploy", "agent", "package-agent.ts"),
    "--json",
    "--out",
    input.outDir,
    "--artifact-base-url",
    input.artifactBaseUrl,
  ], {
    cwd: input.root,
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    throw new Error(
      `bundled Agent package failed: ${
        summarizeCommandOutput(result.stderr || result.stdout) || "unknown error"
      }`,
    );
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (
      typeof parsed?.artifactPath === "string" &&
      typeof parsed?.releaseManifestPath === "string" &&
      typeof parsed?.updateManifestPath === "string" &&
      typeof parsed?.artifactName === "string" &&
      typeof parsed?.sha256 === "string" &&
      typeof parsed?.version === "string"
    ) {
      return parsed;
    }
  } catch {
    // Report a stable packaging error below without leaking full command output.
  }
  throw new Error("bundled Agent package did not return a valid JSON manifest");
}

function dependencyTargetForAppPlatforms(
  platforms: AppReleasePlatform[],
): { os?: string; cpu?: string } | null {
  const targets = platforms.map((platform) => {
    const [os, cpu] = platform.split("-");
    return { os, cpu };
  });
  const osValues = [...new Set(targets.map((target) => target.os))];
  const cpuValues = [...new Set(targets.map((target) => target.cpu))];
  return {
    ...(osValues.length === 1 ? { os: osValues[0] } : {}),
    ...(cpuValues.length === 1 ? { cpu: cpuValues[0] } : {}),
  };
}

function mustGetBundledAgentResource(
  resources: Map<AppReleasePlatform, BundledAgentResource>,
  platform: AppReleasePlatform,
): BundledAgentResource {
  const resource = resources.get(platform);
  if (!resource) {
    throw new Error(`missing bundled Agent resource for ${platform}`);
  }
  return resource;
}

function withBundledAgentMetadata(
  manifest: AppReleaseManifest,
  bundledAgent: BundledAgentResource,
): AppReleaseManifest {
  const payload = {
    ...manifest.bundledAgentPayload,
    version: bundledAgent.version,
    artifactName: bundledAgent.artifactName,
    resourcePath: `bundled-agent/${bundledAgent.artifactName}`,
    integrity: {
      ...manifest.bundledAgentPayload.integrity,
      digest: bundledAgent.sha256,
    },
  };
  return {
    ...manifest,
    bundledAgentVersion: bundledAgent.version,
    bundledAgentPayload: payload,
    components: manifest.components.map((component) => ({
      ...component,
      bundledAgentVersion: bundledAgent.version,
      bundledAgentPayload: payload,
    })),
    artifacts: manifest.artifacts.map((artifact) => ({
      ...artifact,
      bundledAgentVersion: bundledAgent.version,
      bundledAgentPayload: payload,
    })),
  };
}

function verifyMacBundleIcon(root: string, appBundle: string): void {
  const sourceIcon = appReleaseIconPath(root);
  const packagedIcon = join(appBundle, MAC_APP_ICON_RESOURCE);
  if (!existsSync(packagedIcon)) {
    throw new Error(`packaged mac app icon resource is missing: ${packagedIcon}`);
  }
  const sourceHash = sha256File(sourceIcon);
  const packagedHash = sha256File(packagedIcon);
  if (sourceHash !== packagedHash) {
    throw new Error(
      `packaged mac app icon does not match Butler icon: expected ${sourceHash}, got ${packagedHash}`,
    );
  }
  const plistPath = join(appBundle, "Contents", "Info.plist");
  const iconFile = readPlistString(plistPath, "CFBundleIconFile");
  if (iconFile !== "butler.icns") {
    throw new Error(`packaged mac app icon plist is wrong: expected butler.icns, got ${iconFile || "missing"}`);
  }
  const iconName = readPlistString(plistPath, "CFBundleIconName");
  if (iconName !== "butler") {
    throw new Error(`packaged mac app icon name is wrong: expected butler, got ${iconName || "missing"}`);
  }
  const bundleId = readPlistString(plistPath, "CFBundleIdentifier");
  if (bundleId !== MAC_APP_BUNDLE_IDENTIFIER) {
    throw new Error(`packaged mac app bundle id is wrong: expected ${MAC_APP_BUNDLE_IDENTIFIER}, got ${bundleId || "missing"}`);
  }
}

function readPlistString(plistPath: string, key: string): string | null {
  const result = spawnSync("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${key}`,
    plistPath,
  ], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function normalizeMacBundle(root: string, appBundle: string): void {
  const result = spawnSync("node", [join(root, MAC_NORMALIZE_SCRIPT), appBundle], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `mac bundle metadata normalization failed: ${
        result.stderr.trim() || result.stdout.trim() || "unknown error"
      }`,
    );
  }
}

function signMacBundle(root: string, appBundle: string): void {
  const result = spawnSync("node", [join(root, MAC_SIGN_SCRIPT), appBundle], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `mac ad-hoc signing failed: ${
        result.stderr.trim() || result.stdout.trim() || "unknown error"
      }`,
    );
  }
}

function createMacPkg(input: {
  appBundle: string;
  artifactPath: string;
  bundledAgentResourceDir: string;
  version: string;
}): void {
  const workDir = mkdtempSync(join(tmpdir(), "butler-app-pkg-"));
  try {
    const pkgRoot = join(workDir, "root");
    const applicationsDir = join(pkgRoot, "Applications");
    const scriptsDir = join(workDir, "scripts");
    mkdirSync(applicationsDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    cpSync(input.appBundle, join(applicationsDir, "Butler.app"), {
      dereference: false,
      errorOnExist: false,
      force: true,
      recursive: true,
    });
    const postinstall = join(
      input.bundledAgentResourceDir,
      "service-installer",
      "darwin",
      "pkg",
      "postinstall",
    );
    if (!existsSync(postinstall)) {
      throw new Error(`mac pkg postinstall script is missing: ${postinstall}`);
    }
    copyFileSync(postinstall, join(scriptsDir, "postinstall"));
    chmodSync(join(scriptsDir, "postinstall"), 0o755);
    const componentPlist = join(workDir, "components.plist");
    writeMacPkgComponentPlist({
      path: componentPlist,
      rootRelativeBundlePath: join("Applications", "Butler.app"),
    });

    rmSync(input.artifactPath, { force: true });
    const unsignedPkg = process.env.BUTLER_APP_PKG_SIGN_IDENTITY
      ? join(workDir, "Butler-unsigned.pkg")
      : input.artifactPath;
    runPkgbuild({
      root: pkgRoot,
      scripts: scriptsDir,
      componentPlist,
      version: input.version,
      artifactPath: unsignedPkg,
    });
    if (process.env.BUTLER_APP_PKG_SIGN_IDENTITY) {
      runProductbuild({
        packagePath: unsignedPkg,
        artifactPath: input.artifactPath,
        signIdentity: process.env.BUTLER_APP_PKG_SIGN_IDENTITY,
      });
    }
    notarizeMacPkgIfConfigured(input.artifactPath);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function runPkgbuild(input: {
  root: string;
  scripts: string;
  componentPlist: string;
  version: string;
  artifactPath: string;
}): void {
  rmSync(input.artifactPath, { force: true });
  const result = spawnSync("pkgbuild", [
    "--root",
    input.root,
    "--scripts",
    input.scripts,
    "--component-plist",
    input.componentPlist,
    "--identifier",
    MAC_APP_BUNDLE_IDENTIFIER,
    "--version",
    input.version,
    "--install-location",
    "/",
    input.artifactPath,
  ], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `mac app pkgbuild failed: ${
        result.stderr.trim() || result.stdout.trim() || "unknown error"
      }`,
    );
  }
}

function writeMacPkgComponentPlist(input: {
  path: string;
  rootRelativeBundlePath: string;
}): void {
  writeFileSync(
    input.path,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
  <dict>
    <key>BundleHasStrictIdentifier</key>
    <true/>
    <key>BundleIsRelocatable</key>
    <false/>
    <key>BundleIsVersionChecked</key>
    <true/>
    <key>BundleOverwriteAction</key>
    <string>upgrade</string>
    <key>RootRelativeBundlePath</key>
    <string>${input.rootRelativeBundlePath}</string>
  </dict>
</array>
</plist>
`,
  );
}

function runProductbuild(input: {
  packagePath: string;
  artifactPath: string;
  signIdentity: string;
}): void {
  rmSync(input.artifactPath, { force: true });
  const result = spawnSync("productbuild", [
    "--package",
    input.packagePath,
    "--sign",
    input.signIdentity,
    input.artifactPath,
  ], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `mac app productbuild signing failed: ${
        result.stderr.trim() || result.stdout.trim() || "unknown error"
      }`,
    );
  }
}

function notarizeMacPkgIfConfigured(artifactPath: string): void {
  const keychainProfile = process.env.BUTLER_APP_NOTARY_KEYCHAIN_PROFILE?.trim();
  if (!keychainProfile) return;
  if (!process.env.BUTLER_APP_PKG_SIGN_IDENTITY?.trim()) {
    throw new Error(
      "BUTLER_APP_PKG_SIGN_IDENTITY is required when BUTLER_APP_NOTARY_KEYCHAIN_PROFILE is set",
    );
  }
  const submit = spawnSync("xcrun", [
    "notarytool",
    "submit",
    artifactPath,
    "--keychain-profile",
    keychainProfile,
    "--wait",
  ], { encoding: "utf8" });
  if (submit.status !== 0) {
    throw new Error(
      `mac app pkg notarization failed: ${
        submit.stderr.trim() || submit.stdout.trim() || "unknown error"
      }`,
    );
  }
  const staple = spawnSync("xcrun", ["stapler", "staple", artifactPath], {
    encoding: "utf8",
  });
  if (staple.status !== 0) {
    throw new Error(
      `mac app pkg notarization staple failed: ${
        staple.stderr.trim() || staple.stdout.trim() || "unknown error"
      }`,
    );
  }
}

function stageLinuxAppPackageRoot(input: {
  packageRoot: string;
  root: string;
  packagedDir: string;
  platform: AppReleasePlatform;
}): { finalInstallDir: string; installDir: string } {
  const finalInstallDir = join("/opt", "butler", packageDirectoryName(input.platform));
  const installDir = join(input.packageRoot, finalInstallDir.slice(1));
  const binDir = join(input.packageRoot, "usr", "bin");
  const serviceUnitDir = join(input.packageRoot, "usr", "lib", "systemd", "user");
  const serviceLauncherDir = join(input.packageRoot, "usr", "lib", "butler");
  const appDir = join(input.packageRoot, "usr", "share", "applications");
  const iconDir = join(input.packageRoot, "usr", "share", "icons", "hicolor", "512x512", "apps");
  const licenseDir = join(input.packageRoot, "usr", "share", "licenses", "butler-app");
  mkdirSync(dirname(installDir), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(serviceUnitDir, { recursive: true });
  mkdirSync(serviceLauncherDir, { recursive: true });
  mkdirSync(appDir, { recursive: true });
  mkdirSync(iconDir, { recursive: true });
  mkdirSync(licenseDir, { recursive: true });
  cpSync(input.packagedDir, installDir, {
    dereference: false,
    errorOnExist: false,
    force: true,
    recursive: true,
  });
  chmodPackageDirectories(installDir);
  writeExecutableText(join(binDir, "butler-app"), linuxAppLauncher(finalInstallDir));
  writeFileSync(join(serviceUnitDir, "butler.service"), linuxSystemdUserUnit(), "utf8");
  copyFileSync(
    join(
      input.packagedDir,
      "resources",
      "bundled-agent",
      "service-installer",
      "linux",
      "launcher",
      "butler-app-managed-agent-service",
    ),
    join(serviceLauncherDir, "butler-app-managed-agent-service"),
  );
  chmodSync(join(serviceLauncherDir, "butler-app-managed-agent-service"), 0o755);
  copyFileSync(join(input.root, ELECTRON_ROOT, "assets", "icon.png"), join(iconDir, "butler.png"));
  copyFileSync(join(input.root, "LICENSE"), join(licenseDir, "LICENSE"));
  writeFileSync(join(appDir, "butler.desktop"), linuxDesktopEntry(), "utf8");
  return { finalInstallDir, installDir };
}

function createLinuxAppDeb(input: {
  artifactPath: string;
  root: string;
  packagedDir: string;
  platform: AppReleasePlatform;
  version: string;
}): void {
  const architecture = linuxDebArchitecture(input.platform);
  const workDir = mkdtempSync(join(tmpdir(), "butler-app-deb-"));
  try {
    const debRoot = join(workDir, "root");
    const controlDir = join(debRoot, "DEBIAN");
    mkdirSync(controlDir, { recursive: true });
    const { finalInstallDir } = stageLinuxAppPackageRoot({
      packageRoot: debRoot,
      root: input.root,
      packagedDir: input.packagedDir,
      platform: input.platform,
    });
    writeFileSync(
      join(controlDir, "control"),
      linuxDebControl({ architecture, version: input.version }),
      "utf8",
    );
    writeExecutableText(join(controlDir, "postinst"), linuxAppDebPostinst(finalInstallDir));
    rmSync(input.artifactPath, { force: true });
    const result = spawnSync(process.env.BUTLER_APP_DPKG_DEB || "dpkg-deb", [
      "--build",
      "--root-owner-group",
      debRoot,
      input.artifactPath,
    ], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `linux app deb package failed: ${
          result.stderr.trim() || result.stdout.trim() || "unknown error"
        }`,
      );
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function createLinuxAppPacman(input: {
  artifactPath: string;
  root: string;
  packagedDir: string;
  platform: AppReleasePlatform;
  version: string;
}): void {
  if (input.platform !== "linux-x64") {
    throw new Error("pacman App packages currently support linux-x64 only");
  }
  const workDir = mkdtempSync(join(tmpdir(), "butler-app-pacman-"));
  try {
    const buildDir = join(workDir, "build");
    const packageRoot = join(buildDir, "pkgroot");
    mkdirSync(buildDir, { recursive: true });
    const { finalInstallDir } = stageLinuxAppPackageRoot({
      packageRoot,
      root: input.root,
      packagedDir: input.packagedDir,
      platform: input.platform,
    });
    writeFileSync(
      join(buildDir, "PKGBUILD"),
      linuxPacmanPkgbuild({
        version: input.version,
        installDir: finalInstallDir,
      }),
      "utf8",
    );
    rmSync(input.artifactPath, { force: true });
    const result = spawnSync(process.env.BUTLER_APP_MAKEPKG || "makepkg", [
      "--force",
      "--nodeps",
    ], {
      cwd: buildDir,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `linux app pacman package failed: ${
          result.stderr.trim() || result.stdout.trim() || result.error?.message || "unknown error"
        }`,
      );
    }
    const builtPackage = join(buildDir, `butler-app-${input.version}-1-x86_64.pkg.tar.zst`);
    if (!existsSync(builtPackage)) {
      throw new Error(`linux app pacman package was not created: ${builtPackage}`);
    }
    copyFileSync(builtPackage, input.artifactPath);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function chmodPackageDirectories(path: string): void {
  chmodSync(path, 0o755);
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    if (statSync(child).isDirectory()) chmodPackageDirectories(child);
  }
}

function linuxDebArchitecture(platform: AppReleasePlatform): "amd64" | "arm64" {
  if (platform === "linux-x64") return "amd64";
  if (platform === "linux-arm64") return "arm64";
  throw new Error(`unsupported Linux deb platform: ${platform}`);
}

function linuxAppLauncher(installDir: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
chromium_flags=()
if [ "\${BUTLER_APP_ENABLE_GPU:-0}" != "1" ]; then
  chromium_flags+=(--disable-gpu --disable-gpu-compositing)
fi
exec "${installDir}/Butler" "\${chromium_flags[@]}" "$@"
`;
}

function linuxSystemdUserUnit(): string {
  return `[Unit]
Description=Butler Agent background service
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/lib/butler/butler-app-managed-agent-service
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=default.target
`;
}

function linuxDesktopEntry(): string {
  return `[Desktop Entry]
Type=Application
Name=Butler
Comment=Butler desktop app
Exec=butler-app %U
Icon=butler
Terminal=false
Categories=Utility;Development;
StartupWMClass=Butler
`;
}

function linuxDebControl(input: { architecture: "amd64" | "arm64"; version: string }): string {
  return `Package: butler-app
Version: ${input.version}
Section: utils
Priority: optional
Architecture: ${input.architecture}
Maintainer: Hexpy Games <support@hexpy.games>
Depends: libgtk-3-0, libnss3, libxss1, libasound2t64 | libasound2, libgbm1
Description: Butler App
 Butler desktop app with bundled Butler Agent runtime.
`;
}

function linuxPacmanPkgbuild(input: { version: string; installDir: string }): string {
  return `pkgname=butler-app
pkgver=${input.version}
pkgrel=1
pkgdesc='Butler desktop app with bundled Butler Agent runtime'
arch=('x86_64')
url='https://github.com/Hexpy-Games/butler'
license=('MIT')
depends=('gtk3' 'nss' 'libxss' 'alsa-lib' 'libgbm')
options=('!strip' '!debug')

package() {
  cp -a "$srcdir/../pkgroot/." "$pkgdir/"
  find "$pkgdir${input.installDir}" -type d -exec chmod 755 {} +
  chmod 755 "$pkgdir/usr/bin/butler-app"
  chmod 755 "$pkgdir/usr/lib/butler/butler-app-managed-agent-service"
  if [ -f "$pkgdir${input.installDir}/Butler" ] && [ ! -L "$pkgdir${input.installDir}/Butler" ]; then
    chmod 755 "$pkgdir${input.installDir}/Butler" 2>/dev/null || true
  fi
  if [ -f "$pkgdir${input.installDir}/chrome-sandbox" ] && [ ! -L "$pkgdir${input.installDir}/chrome-sandbox" ]; then
    chmod 4755 "$pkgdir${input.installDir}/chrome-sandbox" 2>/dev/null || true
  fi
}
`;
}

function linuxAppDebPostinst(installDir: string): string {
  return `#!/bin/sh
set -eu

if [ -d "${installDir}" ]; then
  find "${installDir}" -type d -exec chmod 755 {} +
  if [ -f "${installDir}/Butler" ] && [ ! -L "${installDir}/Butler" ]; then
    chmod 755 "${installDir}/Butler" 2>/dev/null || true
  fi
  if [ -f "${installDir}/chrome-sandbox" ] && [ ! -L "${installDir}/chrome-sandbox" ]; then
    chmod 4755 "${installDir}/chrome-sandbox" 2>/dev/null || true
  fi
fi

chmod 755 /usr/bin/butler-app 2>/dev/null || true
chmod 755 /usr/lib/butler/butler-app-managed-agent-service 2>/dev/null || true

echo "Butler App installed. First-run will render user paths and enable the service."
exit 0
`;
}

function withArtifactMetadata(
  manifest: AppReleaseManifest,
  artifacts: AppReleasePackageArtifact[],
  artifactBaseUrl?: string | null,
): AppReleaseManifest {
  const byName = new Map(artifacts.map((artifact) => [artifact.artifactName, artifact]));
  const byPlatform = new Map(artifacts.map((artifact) => [artifact.platform, artifact]));
  return {
    ...manifest,
    artifacts: manifest.artifacts.map((artifact) => {
      const packaged = byName.get(artifact.artifactName) ?? byPlatform.get(artifact.platform);
      if (!packaged) return artifact;
      return {
        ...artifact,
        artifactName: packaged.artifactName,
        downloadUrl: artifactDownloadUrl(
          artifactBaseUrl,
          packaged.artifactPath,
          packaged.artifactName,
        ),
        sha256: packaged.sha256,
        integrity: {
          ...artifact.integrity,
          digest: packaged.sha256,
          signature: artifact.signature,
        },
      };
    }),
  };
}

function createAppUpdateManifest(manifest: AppReleaseManifest): Record<string, unknown> {
  return {
    schema: "butler.update-manifest.v1",
    generated_at: new Date().toISOString(),
    product: manifest.product,
    app_version: manifest.version,
    bundled_agent_version: manifest.bundledAgentVersion,
    background_service_capability: manifest.backgroundServiceCapability,
    service_installer_bundle: manifest.serviceInstallerBundle,
    gateway_profile: manifest.gatewayProfile,
    protocol_compatibility: manifest.protocolCompatibility,
    updater_owner: manifest.updaterOwner,
    artifacts: manifest.artifacts.map((artifact) => ({
      component: artifact.component,
      app_version: artifact.version,
      version: artifact.version,
      channel: artifact.channel,
      platform: artifact.platform,
      artifact_url: artifact.downloadUrl,
      sha256: artifact.sha256,
      signature: artifact.signature,
      bundled_components: artifact.bundledComponents,
      product: artifact.product,
      gateway_profile: artifact.gatewayProfile,
      bundled_agent_version: artifact.bundledAgentVersion,
      bundled_agent_payload: artifact.bundledAgentPayload,
      background_service_capability: artifact.backgroundServiceCapability,
      service_installer_bundle: artifact.serviceInstallerBundle,
      protocol_compatibility: artifact.protocolCompatibility,
      integrity: artifact.integrity,
      update_policy: artifact.updatePolicy,
      restart_policy: artifact.restartPolicy,
      updater_owner: artifact.updaterOwner,
      payload_format: artifact.payloadFormat,
      staging_policy: artifact.stagingPolicy,
      activation_policy: artifact.activationPolicy,
      rollback_policy: artifact.rollbackPolicy,
    })),
  };
}

function artifactDownloadUrl(
  artifactBaseUrl: string | null | undefined,
  artifactPath: string,
  artifactName: string,
): string {
  const trimmedBaseUrl = artifactBaseUrl?.trim();
  if (!trimmedBaseUrl) return `file://${artifactPath}`;
  return `${trimmedBaseUrl.replace(/\/+$/, "")}/${artifactName}`;
}

function packageDirectoryName(platform: AppReleasePlatform): string {
  const [electronPlatform, electronArch] = platform.split("-");
  return `Butler-${electronPlatform}-${electronArch}`;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Directory(path: string): string {
  const hash = createHash("sha256");
  for (const file of listFiles(path)) {
    const label = file.slice(path.length + 1).replace(/\\/g, "/");
    hash.update(label);
    hash.update("\0");
    hash.update(sha256File(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listFiles(path: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(path).sort()) {
    const fullPath = join(path, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) result.push(...listFiles(fullPath));
    else if (stat.isFile()) result.push(fullPath);
  }
  return result;
}

function sha256Values(values: string[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeExecutableText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { encoding: "utf8", mode: 0o755 });
  try {
    chmodSync(path, 0o755);
  } catch {
    // Preserve file creation on filesystems that ignore chmod.
  }
}

function summarizeCommandOutput(output: string): string {
  return output.trim().split(/\r?\n/u).slice(-8).join("\n").slice(0, 4000);
}

function assertSupportedPlatforms(platforms: AppReleasePlatform[]): void {
  for (const platform of platforms) {
    if (!APP_RELEASE_PLATFORMS.includes(platform)) {
      throw new Error(`unsupported app release platform: ${platform}`);
    }
  }
}

function parseCliArgs(args: string[]): {
  outDir: string;
  artifactBaseUrl?: string | null;
  platforms?: AppReleasePlatform[];
  linuxPackageFormat?: LinuxAppPackageFormat;
  json: boolean;
} {
  let outDir = join(process.cwd(), "dist", "release", "app");
  let artifactBaseUrl: string | null | undefined;
  let platforms: AppReleasePlatform[] | undefined;
  let linuxPackageFormat: LinuxAppPackageFormat | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--out") {
      outDir = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      outDir = arg.slice("--out=".length);
      continue;
    }
    if (arg === "--artifact-base-url") {
      artifactBaseUrl = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--artifact-base-url=")) {
      artifactBaseUrl = arg.slice("--artifact-base-url=".length);
      continue;
    }
    if (arg === "--platform") {
      platforms = [...(platforms ?? []), parsePlatform(args[index + 1] ?? "")];
      index += 1;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      platforms = [...(platforms ?? []), parsePlatform(arg.slice("--platform=".length))];
      continue;
    }
    if (arg === "--linux-package-format") {
      linuxPackageFormat = parseLinuxPackageFormat(args[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg.startsWith("--linux-package-format=")) {
      linuxPackageFormat = parseLinuxPackageFormat(arg.slice("--linux-package-format=".length));
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  if (!outDir.trim()) throw new Error("--out requires a path");
  return { outDir, artifactBaseUrl, platforms, linuxPackageFormat, json };
}

function parsePlatform(value: string): AppReleasePlatform {
  if (APP_RELEASE_PLATFORMS.includes(value as AppReleasePlatform)) {
    return value as AppReleasePlatform;
  }
  throw new Error(`unsupported app release platform: ${value}`);
}

function parseLinuxPackageFormat(value: string): LinuxAppPackageFormat {
  if (value === "deb" || value === "pacman") return value;
  throw new Error(`unsupported Linux package format: ${value}`);
}

if (import.meta.main) {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const result = createAppReleasePackage({
      root: process.cwd(),
      outDir: args.outDir,
      artifactBaseUrl: args.artifactBaseUrl,
      platforms: args.platforms,
      linuxPackageFormat: args.linuxPackageFormat,
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      for (const artifact of result.artifacts) {
        process.stdout.write(`App release artifact: ${artifact.artifactPath}\n`);
        process.stdout.write(`SHA256: ${artifact.sha256}\n`);
      }
      process.stdout.write(`App release manifest: ${result.releaseManifestPath}\n`);
      process.stdout.write(`App update manifest: ${result.updateManifestPath}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
