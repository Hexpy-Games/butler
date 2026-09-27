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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  type AppReleasePlatform,
  readAppComponentVersions,
} from "./manifest.ts";
import {
  closureFromNativeMacBundle,
  createNativeMacReleaseManifest,
  validateNativeMacReleaseManifest,
  verifyNativeMacBundle,
  type NativeMacReleaseManifest,
  type NativeMacDependencyClosure,
} from "./native-mac-manifest.ts";

export interface AppReleasePackageOptions {
  root: string;
  outDir: string;
  artifactBaseUrl?: string | null;
  platforms?: AppReleasePlatform[];
}

export interface AppReleasePackageArtifact {
  platform: "darwin-arm64";
  artifactName: string;
  artifactPath: string;
  sha256Path: string;
  sha256: string;
  updaterArtifactName: string;
  updaterArtifactPath: string;
  updaterSha256Path: string;
  updaterSha256: string;
  nativeClosure: NativeMacDependencyClosure;
}

export interface AppReleasePackageResult {
  artifacts: AppReleasePackageArtifact[];
  releaseManifestPath: string;
  updateManifestPath: string;
  version: string;
}

export interface BundledAgentResource {
  resourceDir: string;
}

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
  const platforms = options.platforms ?? ["darwin-arm64"];
  if (platforms.length === 0) {
    throw new Error("at least one app release platform is required");
  }
  assertSupportedPlatforms(platforms);
  if (platforms.length !== 1) {
    throw new Error("native darwin-arm64 App releases require exactly one platform");
  }
  if (process.platform !== "darwin") {
    throw new Error("darwin-arm64 App releases must be packaged on macOS for signing");
  }
  return createNativeMacReleasePackage({ ...options, root, outDir });
}

function createNativeMacReleasePackage(options: AppReleasePackageOptions): AppReleasePackageResult {
  const root = resolve(options.root);
  const outDir = resolve(options.outDir);
  const manifest = createNativeMacReleaseManifest(root);
  const issues = validateNativeMacReleaseManifest(root, manifest);
  if (issues.length) throw new Error(`native mac release manifest is invalid: ${issues.join("; ")}`);
  mkdirSync(outDir, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), "butler-native-mac-release-"));
  try {
    const bundledAgent = prepareBundledAgentResource(root, workDir, "darwin-arm64");
    const artifact = packagePlatform({
      root, outDir, workDir, platform: "darwin-arm64", manifest,
      bundledAgentResourceDir: bundledAgent.resourceDir,
    });
    const item = manifest.artifacts[0]!;
    item.downloadUrl = artifactDownloadUrl(options.artifactBaseUrl, artifact.artifactPath, artifact.artifactName);
    item.sha256 = artifact.sha256;
    item.updaterArtifactName = artifact.updaterArtifactName;
    item.updaterSha256 = artifact.updaterSha256;
    item.dependencyClosure = artifact.nativeClosure;
    if (!item.dependencyClosure) throw new Error("signed native mac App closure is missing");
    const releaseManifestPath = join(outDir, "app-release-manifest.json");
    writeJson(releaseManifestPath, manifest);
    const updateManifestPath = join(outDir, "app-update-manifest.json");
    writeJson(updateManifestPath, {
      schema: "butler.update-manifest.v1", product: "butler-app", app_version: manifest.version,
      bundled_agent_version: manifest.bundledAgentVersion, updater_owner: "butler-app",
      artifacts: [{
        component: "app", product: "butler-app", platform: "darwin-arm64", version: manifest.version,
        app_version: manifest.version, channel: "stable", artifact_url: item.downloadUrl,
        sha256: item.sha256, payload_format: "platform-app-package", update_policy: "app-user-action",
        restart_policy: "restart-app", updater_owner: "butler-app",
        bundled_agent_version: manifest.bundledAgentVersion,
        staging_policy: item.stagingPolicy,
        activation_policy: item.activationPolicy,
        rollback_policy: item.rollbackPolicy,
      }],
    });
    return { artifacts: [artifact], releaseManifestPath, updateManifestPath, version: manifest.version };
  } finally {
    makeTreeRemovable(workDir);
    rmSync(workDir, { recursive: true, force: true });
  }
}

function makeTreeRemovable(root: string): void {
  if (!existsSync(root)) return;
  try {
    chmodSync(root, 0o755);
  } catch {
    return;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) makeTreeRemovable(join(root, entry.name));
  }
}

function packagePlatform(input: {
  root: string;
  outDir: string;
  workDir: string;
  platform: "darwin-arm64";
  manifest: NativeMacReleaseManifest;
  bundledAgentResourceDir: string;
}): AppReleasePackageArtifact {
  const artifact = input.manifest.artifacts[0];
  if (!artifact) throw new Error("missing native mac App artifact definition");

  const packageOut = join(input.workDir, input.platform);
  mkdirSync(packageOut, { recursive: true });
  runElectronPackager(
    input.root,
    packageOut,
    input.platform,
    input.bundledAgentResourceDir,
  );
  const packagedDir = join(packageOut, packageDirectoryName());
  if (!existsSync(packagedDir)) {
    throw new Error(`electron package directory was not created: ${packagedDir}`);
  }

  const artifactName = artifact.artifactName;
  const artifactPath = join(input.outDir, artifactName);
  const appBundle = join(packagedDir, "Butler.app");
  if (!existsSync(appBundle)) throw new Error(`mac app bundle not found: ${appBundle}`);
  normalizeMacBundle(input.root, appBundle);
  verifyMacBundleIcon(input.root, appBundle);
  signMacBundle(input.root, appBundle);
  const nativeClosure = closureFromNativeMacBundle(appBundle, input.manifest);
  verifyNativeMacBundle(appBundle, nativeClosure);
  notarizeMacAppIfConfigured(appBundle);
  createMacDmg({ appBundle, artifactPath });
  signAndNotarizeMacContainerIfConfigured(artifactPath);
  const updaterArtifactName = `butler-app-${input.manifest.version}-darwin-arm64.zip`;
  const updaterArtifactPath = join(input.outDir, updaterArtifactName);
  createMacZip(appBundle, updaterArtifactPath);
  const updaterSha256 = sha256File(updaterArtifactPath);
  const updaterSha256Path = `${updaterArtifactPath}.sha256`;
  writeFileSync(
    updaterSha256Path,
    `${updaterSha256}  ${updaterArtifactName}\n`,
    "utf8",
  );
  const sha256 = sha256File(artifactPath);
  const sha256Path = `${artifactPath}.sha256`;
  writeFileSync(sha256Path, `${sha256}  ${basename(artifactPath)}\n`, "utf8");
  return {
    platform: input.platform,
    artifactName,
    artifactPath,
    sha256Path,
    sha256,
    nativeClosure,
    updaterArtifactName,
    updaterArtifactPath,
    updaterSha256,
    updaterSha256Path,
  };
}

function runElectronPackager(
  root: string,
  outDir: string,
  platform: "darwin-arm64",
  bundledAgentResourceDir: string,
): void {
  const packagerOverride = process.env.BUTLER_APP_PACKAGER?.trim();
  const packagerCli = join(
    root,
    ELECTRON_ROOT,
    "node_modules",
    "@electron",
    "packager",
    "bin",
    "electron-packager.mjs",
  );
  if (!packagerOverride && !existsSync(packagerCli)) {
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
  const packagerArguments = [
    join(root, ELECTRON_ROOT),
    "Butler",
    "--platform=darwin",
    "--arch=arm64",
    "--overwrite",
    `--out=${outDir}`,
    `--icon=${packagerIconPath}`,
    `--app-bundle-id=${MAC_APP_BUNDLE_IDENTIFIER}`,
    `--helper-bundle-id=${MAC_HELPER_BUNDLE_IDENTIFIER}`,
    `--extra-resource=${bundledAgentResourceDir}`,
    `--extra-resource=${rendererResourceDir}`,
    "--ignore=^/dist($|/)",
    "--quiet",
  ];
  const result = spawnSync(
    packagerOverride || process.env.BUTLER_NODE || "node",
    packagerOverride ? packagerArguments : [packagerCli, ...packagerArguments],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `electron package failed for ${platform}: ${
        result.stderr.trim() || result.stdout.trim() || result.error?.message || "unknown error"
      }`,
    );
  }
}

export function prepareBundledAgentResource(
  root: string,
  workDir: string,
  platform: AppReleasePlatform = "darwin-arm64",
): BundledAgentResource {
  assertSupportedPlatforms([platform]);
  const versions = readAppComponentVersions(root);
  const version = versions.bundledAgent;
  const appVersion = versions.app;
  const resourceDir = join(workDir, platform, "bundled-agent");
  const [requestedPlatform, requestedArch] = platform.split("-");
  const preparer = join(
    root,
    ELECTRON_ROOT,
    "scripts",
    "prepare-native-agent.mjs",
  );
  const result = spawnSync(
    process.env.BUTLER_NODE || "node",
    [preparer, requestedPlatform, requestedArch, resourceDir],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, BUTLER_NATIVE_PAYLOAD_WRITABLE: "1", BUTLER_PACKAGED_APP_VERSION: appVersion },
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `native bundled Agent preparation failed for ${platform}: ${
        result.stderr.trim() || result.stdout.trim() || result.error?.message || "unknown error"
      }`,
    );
  }
  const nativeManifestPath = join(resourceDir, "native-agent-manifest.json");
  const nativeManifest = JSON.parse(readFileSync(nativeManifestPath, "utf8"));
  if (nativeManifest.version !== version) {
    throw new Error("native bundled Agent version does not match the App release");
  }
  if (nativeManifest.appVersion !== appVersion) {
    throw new Error("native bundled Agent App version does not match the App release");
  }
  const artifactPath = join(resourceDir, "bin", "butler-agent");
  if (!existsSync(artifactPath)) throw new Error("native bundled Agent executable was not created");
  return { resourceDir };
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
  const identity = process.env.BUTLER_APP_SIGN_IDENTITY?.trim();
  if (identity) {
    const result = spawnSync("codesign", [
      "--force",
      "--deep",
      "--options",
      "runtime",
      "--timestamp",
      "--sign",
      identity,
      appBundle,
    ], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`mac Developer ID signing failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    verifyMacCodeSignature(appBundle);
    return;
  }
  if (process.env.BUTLER_APP_REQUIRE_PRODUCTION_SIGNING === "1") {
    throw new Error("BUTLER_APP_SIGN_IDENTITY is required for production macOS releases");
  }
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

function verifyMacCodeSignature(path: string): void {
  const result = spawnSync("codesign", ["--verify", "--deep", "--strict", "--verbose=4", path], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`mac code signature verification failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

function createMacDmg(input: { appBundle: string; artifactPath: string }): void {
  const workDir = mkdtempSync(join(tmpdir(), "butler-app-dmg-"));
  try {
    const staging = join(workDir, "Butler");
    mkdirSync(staging, { recursive: true });
    cpSync(input.appBundle, join(staging, "Butler.app"), {
      dereference: false,
      errorOnExist: false,
      force: true,
      recursive: true,
    });
    symlinkSync("/Applications", join(staging, "Applications"));
    rmSync(input.artifactPath, { force: true });
    const result = spawnSync("hdiutil", [
      "create",
      "-volname",
      "Butler",
      "-srcfolder",
      staging,
      "-ov",
      "-format",
      "UDZO",
      input.artifactPath,
    ], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`mac app DMG creation failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  } finally {
    makeTreeRemovable(workDir);
    rmSync(workDir, { recursive: true, force: true });
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
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`mac app updater ZIP creation failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

function notarizeMacAppIfConfigured(appBundle: string): void {
  const keychainProfile = process.env.BUTLER_APP_NOTARY_KEYCHAIN_PROFILE?.trim();
  if (!keychainProfile) {
    if (process.env.BUTLER_APP_REQUIRE_PRODUCTION_SIGNING === "1") {
      throw new Error("BUTLER_APP_NOTARY_KEYCHAIN_PROFILE is required for production macOS releases");
    }
    return;
  }
  const workDir = mkdtempSync(join(tmpdir(), "butler-app-notary-"));
  try {
    const submission = join(workDir, "Butler.zip");
    createMacZip(appBundle, submission);
    submitMacNotarization(submission, keychainProfile);
    stapleMacArtifact(appBundle);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function signAndNotarizeMacContainerIfConfigured(artifactPath: string): void {
  const identity = process.env.BUTLER_APP_SIGN_IDENTITY?.trim();
  const keychainProfile = process.env.BUTLER_APP_NOTARY_KEYCHAIN_PROFILE?.trim();
  if (!identity || !keychainProfile) return;
  const sign = spawnSync("codesign", ["--force", "--timestamp", "--sign", identity, artifactPath], {
    encoding: "utf8",
  });
  if (sign.status !== 0) throw new Error(`mac DMG signing failed: ${sign.stderr.trim() || sign.stdout.trim()}`);
  submitMacNotarization(artifactPath, keychainProfile);
  stapleMacArtifact(artifactPath);
}

function submitMacNotarization(artifactPath: string, keychainProfile: string): void {
  const submit = spawnSync("xcrun", [
    "notarytool",
    "submit",
    artifactPath,
    "--keychain-profile",
    keychainProfile,
    "--wait",
  ], { encoding: "utf8" });
  if (submit.status !== 0) {
    throw new Error(`mac notarization failed: ${submit.stderr.trim() || submit.stdout.trim()}`);
  }
}

function stapleMacArtifact(artifactPath: string): void {
  const staple = spawnSync("xcrun", ["stapler", "staple", artifactPath], { encoding: "utf8" });
  if (staple.status !== 0) {
    throw new Error(`mac notarization staple failed: ${staple.stderr.trim() || staple.stdout.trim()}`);
  }
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

function packageDirectoryName(): string {
  return "Butler-darwin-arm64";
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertSupportedPlatforms(platforms: AppReleasePlatform[]): void {
  for (const platform of platforms) {
    if (platform !== "darwin-arm64") {
      throw new Error(`native agent-bundled App release is supported only on darwin-arm64; ${platform} is unverified`);
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
  return value as AppReleasePlatform;
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
