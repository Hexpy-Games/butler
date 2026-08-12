import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createReleaseManifest } from
  "../../../packages/butler-agent/src/operations/release/manifest.ts";
import { createAppDependencyClosureManifest } from
  "../../../packages/butler-app/scripts/release/manifest.ts";
import {
  preparedResourceDirectoryIdentity,
  sourceCompatibilitySha256,
  type PreparedButlerResourceReference,
} from "../../support/agent-benchmark/prepared-butler-resource.ts";

export function preparedFixture() {
  const root = mkdtempSync(join(tmpdir(), "butler-prepared-validation-"));
  const sourceRoot = join(root, "source");
  write(sourceRoot, "package.json", `${JSON.stringify({
    name: "butler", version: "0.0.20", bin: { butler: "./bin/butler.js" },
  })}\n`);
  for (const path of [
    "bun.lock", "bin/butler.js", "install.sh", "butler.config.template.json",
    "LICENSE", "README.md",
  ]) write(sourceRoot, path, `${path}\n`);
  write(sourceRoot, "VERSION", "0.0.20\n");
  for (const path of [
    "deploy/agent/input.txt",
    "packages/butler-agent/src/input.ts",
    "packages/butler-agent/scripts/input.ts",
    "packages/butler-agent/resources/input.txt",
    "packages/butler-agent/resources/runtime/bun-version",
    "packages/butler-progress-projection/input.ts",
    "packages/project-ledger/input.ts",
    "packages/butler-app/client/ui/package.json",
    "packages/butler-app/client/ui/bun.lock",
    "packages/butler-app/client/ui/package-lock.json",
    "packages/butler-app/client/ui/index.html",
    "packages/butler-app/client/ui/tsconfig.json",
    "packages/butler-app/client/ui/vite.config.ts",
    "packages/butler-app/client/ui/src/input.ts",
    "packages/butler-app/scripts/release/input.ts",
    "packages/butler-app/scripts/background-service-contract.ts",
    "packages/butler-app/client/electron/package.json",
    "packages/butler-app/client/electron/windows-powershell-environment.mjs",
  ]) write(sourceRoot, path, `${path}\n`);
  execFileSync("git", ["init", "-q", sourceRoot]);
  execFileSync("git", ["-C", sourceRoot, "add", "."]);
  execFileSync("git", [
    "-C", sourceRoot, "-c", "user.name=Test", "-c",
    "user.email=test@example.invalid", "commit", "-qm", "fixture",
  ]);
  const sourceRevision = execFileSync(
    "git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" },
  ).trim();
  const resourceDir = join(root, "resource");
  const archiveName = "butler-agent-0.0.20-darwin-arm64.tar.gz";
  const archive = Buffer.from("immutable prepared archive");
  const archiveSha256 = digest(archive);
  writeFileSync(joinPath(resourceDir, archiveName), archive);
  const manifestValue = createReleaseManifest(sourceRoot);
  manifestValue.cliLaunchers = [manifestValue.cliLaunchers[0]!];
  manifestValue.artifacts = [{
    ...manifestValue.artifacts[0]!,
    artifactName: archiveName,
    downloadUrl: `bundled-agent/${archiveName}`,
    sha256: archiveSha256,
    integrity: {
      ...manifestValue.artifacts[0]!.integrity,
      digest: archiveSha256,
    },
  }];
  const manifest = Buffer.from(`${JSON.stringify(manifestValue)}\n`);
  writeFileSync(joinPath(resourceDir, "agent-release-manifest.json"), manifest);
  writeFileSync(joinPath(resourceDir, "runtime/worker.mjs"), "runtime\n", "utf8");
  writeFileSync(joinPath(resourceDir, "agent-update-manifest.json"), "{\"update\":true}\n");
  writeFileSync(joinPath(resourceDir, "background-service-capability.json"), "{\"capability\":true}\n");
  writeFileSync(joinPath(resourceDir, "background-service-registration.json"), "{\"registration\":true}\n");
  writeFileSync(joinPath(resourceDir, "service-installer/manifest.json"), "{\"installer\":true}\n");
  const manifestSha256 = digest(manifest);
  const updateSha256 = fileDigest(join(resourceDir, "agent-update-manifest.json"));
  const runtimeSha256 = producerDirectoryDigest(join(resourceDir, "runtime"));
  const backgroundSha256 = digestValues([
    fileDigest(join(resourceDir, "background-service-capability.json")),
    fileDigest(join(resourceDir, "background-service-registration.json")),
    producerDirectoryDigest(join(resourceDir, "service-installer")),
  ]);
  const closure = createAppDependencyClosureManifest({
    bundledAgentVersion: "0.0.20",
    bundledAgentArtifactName: archiveName,
    bundledAgentSha256: archiveSha256,
    releaseManifestSha256: manifestSha256,
    updateManifestSha256: updateSha256,
    managedRuntimeSha256: runtimeSha256,
    backgroundServiceRegistrationMetadataSha256: backgroundSha256,
    releaseManifestsSha256: digestValues([manifestSha256, updateSha256]),
    runtimePackageDependenciesSha256: digestValues([archiveSha256, runtimeSha256]),
    repairSourceSha256: digestValues([
      archiveSha256, manifestSha256, updateSha256, runtimeSha256, backgroundSha256,
    ]),
  });
  const closureBytes = Buffer.from(`${JSON.stringify(closure)}\n`);
  writeFileSync(joinPath(resourceDir, "dependency-closure.json"), closureBytes);
  const reference: PreparedButlerResourceReference = {
    resourceDir,
    sourceRevision,
    sourceCompatibilitySha256: sourceCompatibilitySha256(sourceRoot),
    manifestSha256,
    dependencyClosureSha256: digest(closureBytes),
    ...(() => {
      const identity = preparedResourceDirectoryIdentity(resourceDir);
      return { resourceSha256: identity.sha256, resourceBytes: identity.bytes };
    })(),
    archiveSha256,
    archiveBytes: archive.byteLength,
  };
  return {
    root,
    sourceRoot,
    resourceDir,
    reference,
    input: { reference, sourceRoot, sourceRevision },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function write(root: string, path: string, contents: string): void {
  const output = joinPath(root, path);
  writeFileSync(output, contents, "utf8");
}

function joinPath(root: string, path: string): string {
  const output = join(root, path);
  mkdirSync(dirname(output), { recursive: true });
  return output;
}

function fileDigest(path: string): string {
  return digest(readFileSync(path));
}

function producerDirectoryDigest(root: string): string {
  const hash = createHash("sha256");
  const files: string[] = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
    } else if (stat.isFile()) files.push(path);
  };
  visit(root);
  for (const path of files) {
    hash.update(path.slice(root.length + 1).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(fileDigest(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function digestValues(values: string[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
}
