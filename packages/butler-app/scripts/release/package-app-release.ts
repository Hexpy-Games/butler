#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
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

const ELECTRON_ROOT = join("packages", "butler-app", "client", "electron");
const MAC_SIGN_SCRIPT = join(ELECTRON_ROOT, "scripts", "adhoc-sign-mac.mjs");

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
    const artifacts = platforms.map((platform) =>
      packagePlatform({
        root,
        outDir,
        workDir,
        platform,
        manifest,
      }),
    );
    const releaseManifest = withArtifactMetadata(
      manifest,
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
  runElectronPackager(input.root, packageOut, input.platform);
  const packagedDir = join(packageOut, packageDirectoryName(input.platform));
  if (!existsSync(packagedDir)) {
    throw new Error(`electron package directory was not created: ${packagedDir}`);
  }

  const artifactPath = join(input.outDir, artifact.artifactName);
  if (input.platform === "darwin-arm64") {
    const appBundle = join(packagedDir, "Butler.app");
    if (!existsSync(appBundle)) throw new Error(`mac app bundle not found: ${appBundle}`);
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
): void {
  const packager = process.env.BUTLER_APP_PACKAGER ||
    join(root, ELECTRON_ROOT, "node_modules", ".bin", "electron-packager");
  if (!existsSync(packager)) {
    throw new Error(
      "Electron packager is missing; run npm --prefix packages/butler-app/client/electron ci",
    );
  }
  const [electronPlatform, electronArch] = platform.split("-");
  const result = spawnSync(packager, [
    join(root, ELECTRON_ROOT),
    "Butler",
    `--platform=${electronPlatform}`,
    `--arch=${electronArch}`,
    "--overwrite",
    `--out=${outDir}`,
    "--icon=assets/butler.icns",
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
      update_policy: artifact.updatePolicy,
      restart_policy: artifact.restartPolicy,
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
