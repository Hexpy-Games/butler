#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { spawnSync } from "node:child_process";
import {
  createReleaseManifest,
  validateReleaseManifest,
  type ReleaseManifest,
} from "./manifest.ts";

export interface ServiceReleasePackageOptions {
  root: string;
  outDir: string;
}

export interface ServiceReleasePackageResult {
  artifactPath: string;
  sha256Path: string;
  releaseManifestPath: string;
  updateManifestPath: string;
  sha256: string;
  artifactName: string;
  version: string;
}

const SERVICE_WORKSPACES = [
  "packages/project-ledger",
  "packages/butler-agent/src/interfaces/mcp-server",
  "packages/butler-agent/src/integrations/telegram",
] as const;

const SERVICE_ROOT_SCRIPTS = [
  "setup",
  "release:service:gate",
  "release:service:package",
] as const;

const IGNORED_PATH_SEGMENTS = new Set([
  ".git",
  ".DS_Store",
  "coverage",
  "dist",
  "node_modules",
]);

export function createServiceReleasePackage(
  options: ServiceReleasePackageOptions,
): ServiceReleasePackageResult {
  const root = resolve(options.root);
  const outDir = resolve(options.outDir);
  const manifest = createReleaseManifest(root);
  const issues = validateReleaseManifest(root, manifest);
  if (issues.length > 0) {
    throw new Error(`service release manifest is invalid: ${issues.join("; ")}`);
  }

  mkdirSync(outDir, { recursive: true });
  const stageRoot = mkdtempSync(join(tmpdir(), "butler-service-release-"));
  try {
    copyManifestFiles(root, stageRoot, manifest);
    writeServicePackageJson(root, stageRoot);
    stripMacExtendedAttributes(stageRoot);
    const releaseManifestPath = join(outDir, "service-release-manifest.json");
    writeJson(releaseManifestPath, manifest);

    const artifactName = manifest.artifacts.find((artifact) =>
      artifact.component === "service",
    )?.artifactName ?? `butler-service-${manifest.version}-all.tar.gz`;
    const artifactPath = join(outDir, artifactName);
    createTarball(stageRoot, artifactPath);

    const sha256 = sha256File(artifactPath);
    const sha256Path = `${artifactPath}.sha256`;
    writeFileSync(sha256Path, `${sha256}  ${basename(artifactPath)}\n`, "utf8");

    const updateManifestPath = join(outDir, "update-manifest.json");
    writeJson(updateManifestPath, createUpdateManifest(manifest, artifactPath, sha256));

    return {
      artifactPath,
      sha256Path,
      releaseManifestPath,
      updateManifestPath,
      sha256,
      artifactName,
      version: manifest.version,
    };
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

function copyManifestFiles(
  root: string,
  stageRoot: string,
  manifest: ReleaseManifest,
): void {
  for (const requiredFile of manifest.requiredFiles) {
    const source = join(root, requiredFile);
    if (!existsSync(source)) {
      throw new Error(`missing required service release file: ${requiredFile}`);
    }
    const destination = join(stageRoot, requiredFile);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, {
      dereference: false,
      errorOnExist: false,
      force: true,
      recursive: true,
      filter: (sourcePath) => shouldCopy(root, sourcePath),
    });
  }
}

function shouldCopy(root: string, sourcePath: string): boolean {
  const label = relative(root, sourcePath);
  if (!label) return true;
  const parts = label.split(sep);
  if (parts.some((part) => IGNORED_PATH_SEGMENTS.has(part))) return false;
  return !toPosix(label).startsWith("packages/butler-app/");
}

function writeServicePackageJson(root: string, stageRoot: string): void {
  const sourcePackage = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as Record<string, any>;
  const scripts = sourcePackage.scripts && typeof sourcePackage.scripts === "object"
    ? sourcePackage.scripts as Record<string, string>
    : {};
  const serviceScripts = Object.fromEntries(
    SERVICE_ROOT_SCRIPTS
      .filter((scriptName) => typeof scripts[scriptName] === "string")
      .map((scriptName) => [scriptName, scripts[scriptName]]),
  );

  writeJson(join(stageRoot, "package.json"), {
    ...sourcePackage,
    private: true,
    workspaces: [...SERVICE_WORKSPACES],
    scripts: serviceScripts,
  });
}

function createTarball(stageRoot: string, artifactPath: string): void {
  const result = spawnSync("tar", [
    "--format",
    "ustar",
    "-czf",
    artifactPath,
    "-C",
    stageRoot,
    ".",
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
      `tar failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`,
    );
  }
}

function stripMacExtendedAttributes(stageRoot: string): void {
  const result = spawnSync("xattr", ["-cr", stageRoot], { encoding: "utf8" });
  const error = result.error as { code?: string } | undefined;
  if (error?.code === "ENOENT") return;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function createUpdateManifest(
  manifest: ReleaseManifest,
  artifactPath: string,
  sha256: string,
): Record<string, unknown> {
  return {
    schema: "butler.update-manifest.v1",
    generated_at: new Date().toISOString(),
    artifacts: manifest.artifacts.map((artifact) => ({
      component: artifact.component,
      version: artifact.version,
      channel: artifact.channel,
      artifact_url: `file://${artifactPath}`,
      sha256,
      signature: artifact.signature,
      bundled_components: artifact.bundledComponents,
      update_policy: artifact.updatePolicy,
      restart_policy: artifact.restartPolicy,
    })),
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function parseCliArgs(args: string[]): { outDir: string; json: boolean } {
  let outDir = join(process.cwd(), "dist", "release", "service");
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
    throw new Error(`unknown option: ${arg}`);
  }
  if (!outDir.trim()) throw new Error("--out requires a path");
  return { outDir, json };
}

if (import.meta.main) {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const result = createServiceReleasePackage({
      root: process.cwd(),
      outDir: args.outDir,
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Service release artifact: ${result.artifactPath}\n`);
      process.stdout.write(`SHA256: ${result.sha256}\n`);
      process.stdout.write(`Update manifest: ${result.updateManifestPath}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
