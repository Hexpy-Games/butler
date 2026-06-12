#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  chmodSync,
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
  SERVICE_APP_WEB_CLIENT_DIST,
  SERVICE_CLI_LAUNCHER_PLATFORMS,
  serviceCliLauncherBuildTarget,
  serviceCliLauncherRelativePath,
  validateReleaseManifest,
  type ServiceCliLauncherPlatform,
  type ReleaseManifest,
} from "./manifest.ts";

export interface ServiceReleasePackageOptions {
  root: string;
  outDir: string;
  artifactBaseUrl?: string | null;
  cliLauncherPlatforms?: ServiceCliLauncherPlatform[];
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
  "release:agent:gate",
  "release:agent:package",
] as const;

const IGNORED_PATH_SEGMENTS = new Set([
  ".git",
  ".DS_Store",
  "coverage",
  "dist",
  "node_modules",
]);

export function currentServiceCliLauncherPlatform(): ServiceCliLauncherPlatform {
  const os = process.platform === "darwin" ? "darwin" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const platform = `${os}-${arch}`;
  if (SERVICE_CLI_LAUNCHER_PLATFORMS.includes(platform as ServiceCliLauncherPlatform)) {
    return platform as ServiceCliLauncherPlatform;
  }
  throw new Error(`unsupported service CLI launcher platform: ${platform}`);
}

export function createServiceReleasePackage(
  options: ServiceReleasePackageOptions,
): ServiceReleasePackageResult {
  const root = resolve(options.root);
  const outDir = resolve(options.outDir);
  const manifest = createReleaseManifest(root);
  const issues = validateReleaseManifest(root, manifest);
  if (issues.length > 0) {
    throw new Error(`Butler Agent release manifest is invalid: ${issues.join("; ")}`);
  }

  mkdirSync(outDir, { recursive: true });
  const stageRoot = mkdtempSync(join(tmpdir(), "butler-agent-release-"));
  try {
    const cliLauncherPlatforms = options.cliLauncherPlatforms ??
      [...SERVICE_CLI_LAUNCHER_PLATFORMS];
    const cliLauncherPlatformSet = new Set(cliLauncherPlatforms);
    const packagedManifest: ReleaseManifest = {
      ...manifest,
      cliLaunchers: manifest.cliLaunchers.filter((launcher) =>
        cliLauncherPlatformSet.has(launcher.platform),
      ),
    };
    copyManifestFiles(root, stageRoot, manifest);
    writeServicePackageJson(root, stageRoot);
    buildAppWebClientDist(root, stageRoot);
    buildPrebuiltCliLaunchers(
      root,
      stageRoot,
      cliLauncherPlatforms,
    );
    stripMacExtendedAttributes(stageRoot);
    const artifactName = manifest.artifacts.find((artifact) =>
      artifact.component === "service",
    )?.artifactName ?? `butler-agent-${manifest.version}-all.tar.gz`;
    const artifactPath = join(outDir, artifactName);
    createTarball(stageRoot, artifactPath);

    const sha256 = sha256File(artifactPath);
    const sha256Path = `${artifactPath}.sha256`;
    writeFileSync(sha256Path, `${sha256}  ${basename(artifactPath)}\n`, "utf8");

    const artifactUrl = artifactDownloadUrl(
      options.artifactBaseUrl,
      artifactPath,
      artifactName,
    );
    const releaseManifestPath = join(outDir, "agent-release-manifest.json");
    const releaseManifest = withArtifactMetadata(
      packagedManifest,
      artifactName,
      artifactUrl,
      sha256,
    );
    writeJson(releaseManifestPath, releaseManifest);

    const updateManifestPath = join(outDir, "agent-update-manifest.json");
    writeJson(updateManifestPath, createUpdateManifest(
      releaseManifest,
      artifactUrl,
      sha256,
      cliLauncherPlatforms,
    ));

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
      throw new Error(`missing required Butler Agent release file: ${requiredFile}`);
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

function buildAppWebClientDist(root: string, stageRoot: string): void {
  const uiRoot = join(root, "packages", "butler-app", "client", "ui");
  const sourceDist = join(uiRoot, "dist");
  const result = spawnSync(process.env.BUTLER_NPM || "npm", [
    "--prefix",
    "packages/butler-app/client/ui",
    "run",
    "--silent",
    "build",
  ], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `app web client build failed: ${
        summarizeCommandOutput(result.stderr || result.stdout) || "unknown error"
      }`,
    );
  }
  if (!existsSync(join(sourceDist, "index.html"))) {
    throw new Error("app web client build did not produce dist/index.html");
  }
  const output = join(stageRoot, SERVICE_APP_WEB_CLIENT_DIST);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(dirname(output), { recursive: true });
  cpSync(sourceDist, output, {
    dereference: false,
    errorOnExist: false,
    force: true,
    recursive: true,
  });
}

function summarizeCommandOutput(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= 4000) return trimmed;
  return `${trimmed.slice(0, 4000)}\n...<truncated>`;
}

function buildPrebuiltCliLaunchers(
  root: string,
  stageRoot: string,
  platforms: ServiceCliLauncherPlatform[],
): void {
  const launcherSource = join(
    root,
    "packages",
    "butler-agent",
    "src",
    "interfaces",
    "cli",
    "launcher.ts",
  );
  for (const platform of platforms) {
    const output = join(stageRoot, serviceCliLauncherRelativePath(platform));
    mkdirSync(dirname(output), { recursive: true });
    const result = spawnSync(process.env.BUTLER_BUN || "bun", [
      "build",
      "--compile",
      "--target",
      serviceCliLauncherBuildTarget(platform),
      "--outfile",
      output,
      launcherSource,
    ], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `CLI launcher build failed for ${platform}: ${
          result.stderr.trim() || result.stdout.trim() || "unknown error"
        }`,
      );
    }
    chmodSync(output, 0o755);
  }
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

function artifactDownloadUrl(
  artifactBaseUrl: string | null | undefined,
  artifactPath: string,
  artifactName: string,
): string {
  const trimmedBaseUrl = artifactBaseUrl?.trim();
  if (!trimmedBaseUrl) return `file://${artifactPath}`;
  return `${trimmedBaseUrl.replace(/\/+$/, "")}/${artifactName}`;
}

function withArtifactMetadata(
  manifest: ReleaseManifest,
  artifactName: string,
  downloadUrl: string,
  sha256: string,
): ReleaseManifest {
  return {
    ...manifest,
    artifacts: manifest.artifacts.map((artifact) =>
      artifact.artifactName === artifactName
        ? {
            ...artifact,
            downloadUrl,
            sha256,
            integrity: {
              ...artifact.integrity,
              digest: sha256,
              signature: artifact.signature,
            },
          }
        : artifact,
    ),
  };
}

function createUpdateManifest(
  manifest: ReleaseManifest,
  artifactUrl: string,
  sha256: string,
  cliLauncherPlatforms: ServiceCliLauncherPlatform[],
): Record<string, unknown> {
  const platformSet = new Set(cliLauncherPlatforms);
  return {
    schema: "butler.update-manifest.v1",
    generated_at: new Date().toISOString(),
    artifacts: manifest.artifacts.map((artifact) => ({
      component: artifact.component,
      version: artifact.version,
      channel: artifact.channel,
      artifact_url: artifact.downloadUrl ?? artifactUrl,
      sha256: artifact.sha256 ?? sha256,
      signature: artifact.signature,
      bundled_components: artifact.bundledComponents,
      product: artifact.product,
      canonical_component: artifact.canonicalComponent,
      profile: artifact.profile,
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
    cli_launchers: manifest.cliLaunchers
      .filter((launcher) => platformSet.has(launcher.platform))
      .map((launcher) => ({
        platform: launcher.platform,
        path: launcher.path,
        build_target: launcher.buildTarget,
      })),
    app_web_client_dist: manifest.appWebClientDist,
    agent_artifact_layout: {
      executable: manifest.agentArtifactLayout.executable,
      runtime_resolver: manifest.agentArtifactLayout.runtimeResolver,
      runtime_payload: manifest.agentArtifactLayout.runtimePayload,
      config_templates: manifest.agentArtifactLayout.configTemplates,
      service_templates: manifest.agentArtifactLayout.serviceTemplates,
      manifest_path: manifest.agentArtifactLayout.manifestPath,
    },
    operator_commands: manifest.operatorCommands,
    operator_command_map: Object.fromEntries(
      Object.entries(manifest.operatorCommandMap).map(([command, argv]) => [
        command,
        argv,
      ]),
    ),
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function parseCliArgs(args: string[]): {
  outDir: string;
  artifactBaseUrl?: string | null;
  json: boolean;
} {
  let outDir = join(process.cwd(), "dist", "release", "service");
  let artifactBaseUrl: string | null | undefined;
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
    throw new Error(`unknown option: ${arg}`);
  }
  if (!outDir.trim()) throw new Error("--out requires a path");
  return { outDir, artifactBaseUrl, json };
}

if (import.meta.main) {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const result = createServiceReleasePackage({
      root: process.cwd(),
      outDir: args.outDir,
      artifactBaseUrl: args.artifactBaseUrl,
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Butler Agent release artifact: ${result.artifactPath}\n`);
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
