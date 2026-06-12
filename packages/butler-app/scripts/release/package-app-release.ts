#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  APP_RELEASE_PLATFORMS,
  createAppReleaseManifest,
  validateAppReleaseManifest,
  type AppReleaseManifest,
  type AppReleasePlatform,
} from "./manifest.ts";

export interface AppReleasePackageOptions {
  root: string;
  outDir: string;
  artifactBaseUrl?: string | null;
  platforms?: AppReleasePlatform[];
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
}

const ELECTRON_ROOT = join("packages", "butler-app", "client", "electron");
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
  mkdirSync(outDir, { recursive: true });

  const workDir = mkdtempSync(join(tmpdir(), "butler-app-release-"));
  try {
    const bundledAgent = prepareBundledAgentResource(root, workDir);
    const artifacts = platforms.map((platform) =>
      packagePlatform({
        root,
        outDir,
        workDir,
        platform,
        manifest,
        bundledAgentResourceDir: bundledAgent.resourceDir,
      }),
    );
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

  const artifactPath = join(input.outDir, artifact.artifactName);
  if (input.platform === "darwin-arm64") {
    const appBundle = join(packagedDir, "Butler.app");
    if (!existsSync(appBundle)) throw new Error(`mac app bundle not found: ${appBundle}`);
    normalizeMacBundle(input.root, appBundle);
    verifyMacBundleIcon(input.root, appBundle);
    signMacBundle(input.root, appBundle);
    createMacZip(appBundle, artifactPath);
  } else {
    createTarball(packagedDir, artifactPath);
  }

  const sha256 = sha256File(artifactPath);
  const sha256Path = `${artifactPath}.sha256`;
  writeFileSync(sha256Path, `${sha256}  ${basename(artifactPath)}\n`, "utf8");
  return {
    platform: input.platform,
    artifactName: artifact.artifactName,
    artifactPath,
    sha256Path,
    sha256,
  };
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

export function prepareBundledAgentResource(root: string, workDir: string): BundledAgentResource {
  const agentOutDir = join(workDir, "agent-release");
  const resourceDir = join(workDir, "bundled-agent");
  const agent = createAgentReleasePackage({
    root,
    outDir: agentOutDir,
    artifactBaseUrl: "bundled-agent",
  });
  mkdirSync(resourceDir, { recursive: true });
  copyFileSync(agent.artifactPath, join(resourceDir, agent.artifactName));
  copyFileSync(agent.releaseManifestPath, join(resourceDir, "agent-release-manifest.json"));
  copyFileSync(agent.updateManifestPath, join(resourceDir, "agent-update-manifest.json"));
  cpSync(
    join(root, "packages", "butler-agent", "resources", "runtime"),
    join(resourceDir, "runtime"),
    { recursive: true },
  );
  writeJson(join(resourceDir, "dependency-closure.json"), {
    schema: "butler.app-bundled-agent-dependency-closure.v1",
    product: "butler-app",
    bundledAgentVersion: agent.version,
    payload: {
      product: "butler-agent",
      artifactName: agent.artifactName,
      sha256: agent.sha256,
    },
    hostToolsRequiredForFirstLaunch: [],
    appOwnedPayloads: [
      "bundled-agent/agent-release-manifest.json",
      "bundled-agent/agent-update-manifest.json",
      `bundled-agent/${agent.artifactName}`,
      "bundled-agent/runtime/bun-version",
    ],
    rawTextIncluded: false,
  });
  return {
    resourceDir,
    artifactName: agent.artifactName,
    sha256: agent.sha256,
    version: agent.version,
  };
}

function createAgentReleasePackage(input: {
  root: string;
  outDir: string;
  artifactBaseUrl: string;
}): {
  artifactPath: string;
  releaseManifestPath: string;
  updateManifestPath: string;
  artifactName: string;
  sha256: string;
  version: string;
} {
  const bun = process.env.BUTLER_BUN || "bun";
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

function createMacZip(appBundle: string, artifactPath: string): void {
  rmSync(artifactPath, { force: true });
  const result = spawnSync("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    appBundle,
    artifactPath,
  ], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `mac app zip failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`,
    );
  }
}

function createTarball(sourceDir: string, artifactPath: string): void {
  rmSync(artifactPath, { force: true });
  const result = spawnSync("tar", [
    "--format",
    "ustar",
    "-czf",
    artifactPath,
    "-C",
    dirname(sourceDir),
    basename(sourceDir),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      COPYFILE_DISABLE: "1",
      COPY_EXTENDED_ATTRIBUTES_DISABLE: "1",
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `app tarball failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`,
    );
  }
}

function withArtifactMetadata(
  manifest: AppReleaseManifest,
  artifacts: AppReleasePackageArtifact[],
  artifactBaseUrl?: string | null,
): AppReleaseManifest {
  const byName = new Map(artifacts.map((artifact) => [artifact.artifactName, artifact]));
  return {
    ...manifest,
    artifacts: manifest.artifacts.map((artifact) => {
      const packaged = byName.get(artifact.artifactName);
      if (!packaged) return artifact;
      return {
        ...artifact,
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
    artifacts: manifest.artifacts.map((artifact) => ({
      component: artifact.component,
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

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
  json: boolean;
} {
  let outDir = join(process.cwd(), "dist", "release", "app");
  let artifactBaseUrl: string | null | undefined;
  let platforms: AppReleasePlatform[] | undefined;
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
    throw new Error(`unknown option: ${arg}`);
  }
  if (!outDir.trim()) throw new Error("--out requires a path");
  return { outDir, artifactBaseUrl, platforms, json };
}

function parsePlatform(value: string): AppReleasePlatform {
  if (APP_RELEASE_PLATFORMS.includes(value as AppReleasePlatform)) {
    return value as AppReleasePlatform;
  }
  throw new Error(`unsupported app release platform: ${value}`);
}

if (import.meta.main) {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const result = createAppReleasePackage({
      root: process.cwd(),
      outDir: args.outDir,
      artifactBaseUrl: args.artifactBaseUrl,
      platforms: args.platforms,
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
