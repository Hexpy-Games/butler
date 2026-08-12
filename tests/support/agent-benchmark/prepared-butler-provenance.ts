import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  createReleaseManifest,
  type ReleaseArtifact,
  type ReleaseManifest,
} from "../../../packages/butler-agent/src/operations/release/manifest.ts";
import {
  createAppDependencyClosureManifest,
  validateAppDependencyClosureManifest,
  type AppDependencyClosureManifest,
} from "../../../packages/butler-app/scripts/release/manifest.ts";
import { PreparedButlerResourceError } from "./prepared-butler-resource-error.ts";

export function validatePreparedButlerProvenance(input: {
  sourceRoot: string;
  resourceDir: string;
  manifestBytes: Buffer;
  manifestSha256: string;
  dependencyClosureSha256: string;
  archiveSha256: string;
}): string {
  const manifest = parseJson(input.manifestBytes, "prepared_resource_manifest_invalid") as
    ReleaseManifest;
  validateReleaseShape(input.sourceRoot, manifest, input.archiveSha256);
  const artifact = manifest.artifacts[0]!;
  const artifactName = artifact.artifactName;
  if (!artifactName || basename(artifactName) !== artifactName) fail("prepared_resource_manifest_identity_mismatch");

  const closureBytes = boundedFile(join(input.resourceDir, "dependency-closure.json"));
  if (digest(closureBytes) !== input.dependencyClosureSha256) {
    fail("prepared_resource_dependency_closure_hash_mismatch");
  }
  const closure = parseJson(
    closureBytes,
    "prepared_resource_dependency_closure_invalid",
  ) as AppDependencyClosureManifest;
  validateClosureShape(closure);
  validateClosureLinkage(input.resourceDir, closure, {
    artifactName,
    archiveSha256: input.archiveSha256,
    manifestSha256: input.manifestSha256,
    version: manifest.version,
  });
  return artifactName;
}

function validateReleaseShape(
  sourceRoot: string,
  actual: ReleaseManifest,
  archiveSha256: string,
): void {
  const expected = createReleaseManifest(sourceRoot);
  if (!actual || !Array.isArray(actual.cliLaunchers) || actual.cliLaunchers.length !== 1 ||
      !expected.cliLaunchers.some((launcher) => isDeepStrictEqual(launcher, actual.cliLaunchers[0])) ||
      !Array.isArray(actual.artifacts) || actual.artifacts.length !== 1) {
    fail("prepared_resource_manifest_provenance_invalid");
  }
  const { cliLaunchers: _expectedLaunchers, artifacts: expectedArtifacts, ...expectedCore } = expected;
  const { cliLaunchers: _actualLaunchers, artifacts: actualArtifacts, ...actualCore } = actual;
  if (!isDeepStrictEqual(actualCore, expectedCore)) fail("prepared_resource_manifest_provenance_invalid");
  validateArtifact(expectedArtifacts[0]!, actualArtifacts[0]!, archiveSha256);
  const artifactPlatform = currentPlatformSegment(actualArtifacts[0]!.artifactName);
  if (actual.cliLaunchers[0]!.platform !== artifactPlatform ||
      artifactPlatform !== currentHostAppPlatform()) {
    fail("prepared_resource_manifest_provenance_invalid");
  }
}

function validateArtifact(
  expected: ReleaseArtifact,
  actual: ReleaseArtifact,
  archiveSha256: string,
): void {
  const {
    artifactName: _expectedName,
    downloadUrl: _expectedUrl,
    sha256: _expectedSha,
    integrity: _expectedIntegrity,
    ...expectedPolicy
  } = expected;
  const {
    artifactName,
    downloadUrl,
    sha256,
    integrity,
    ...actualPolicy
  } = actual;
  if (!isDeepStrictEqual(actualPolicy, expectedPolicy) ||
      artifactName !== `butler-agent-${actual.version}-${currentPlatformSegment(artifactName)}.tar.gz` ||
      downloadUrl !== `bundled-agent/${artifactName}` ||
      sha256 !== archiveSha256 || integrity?.digestAlgorithm !== "sha256" ||
      integrity.digest !== archiveSha256 || actual.signature !== null ||
      integrity.signature !== null) {
    fail("prepared_resource_manifest_identity_mismatch");
  }
}

function currentPlatformSegment(artifactName: string): string {
  const match = /^butler-agent-.+-(darwin-(?:arm64|x64)|linux-(?:arm64|x64)|windows-x64)\.tar\.gz$/u
    .exec(artifactName);
  if (!match?.[1]) fail("prepared_resource_manifest_identity_mismatch");
  return match[1];
}

function currentHostAppPlatform(): string {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const host = `${platform}-${arch}`;
  if (!/^(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)|windows-x64)$/u.test(host)) {
    fail("prepared_resource_manifest_provenance_invalid");
  }
  return host;
}

function validateClosureShape(closure: AppDependencyClosureManifest): void {
  try {
    if (validateAppDependencyClosureManifest(closure).length > 0) {
      fail("prepared_resource_dependency_closure_invalid");
    }
  } catch (error) {
    if (error instanceof PreparedButlerResourceError) throw error;
    fail("prepared_resource_dependency_closure_invalid");
  }
}

function validateClosureLinkage(
  resourceDir: string,
  closure: AppDependencyClosureManifest,
  expected: {
    artifactName: string;
    archiveSha256: string;
    manifestSha256: string;
    version: string;
  },
): void {
  const updateSha = fileDigest(join(resourceDir, "agent-update-manifest.json"));
  const runtimeSha = producerDirectoryDigest(join(resourceDir, "runtime"));
  const capabilitySha = fileDigest(join(resourceDir, "background-service-capability.json"));
  const registrationSha = fileDigest(join(resourceDir, "background-service-registration.json"));
  const installerSha = producerDirectoryDigest(join(resourceDir, "service-installer"));
  const backgroundSha = digestValues([capabilitySha, registrationSha, installerSha]);
  const releaseSha = digestValues([expected.manifestSha256, updateSha]);
  const runtimePackageSha = digestValues([expected.archiveSha256, runtimeSha]);
  const repairSha = digestValues([
    expected.archiveSha256,
    expected.manifestSha256,
    updateSha,
    runtimeSha,
    backgroundSha,
  ]);
  const expectedClosure = createAppDependencyClosureManifest({
    bundledAgentVersion: expected.version,
    bundledAgentArtifactName: expected.artifactName,
    bundledAgentSha256: expected.archiveSha256,
    releaseManifestSha256: expected.manifestSha256,
    updateManifestSha256: updateSha,
    managedRuntimeSha256: runtimeSha,
    backgroundServiceRegistrationMetadataSha256: backgroundSha,
    releaseManifestsSha256: releaseSha,
    runtimePackageDependenciesSha256: runtimePackageSha,
    repairSourceSha256: repairSha,
  });
  if (!isDeepStrictEqual(closure, expectedClosure)) {
    fail("prepared_resource_dependency_closure_identity_mismatch");
  }
}

function producerDirectoryDigest(root: string): string {
  const hash = createHash("sha256");
  const files: string[] = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
    } else if (stat.isFile()) files.push(path);
    else fail("prepared_resource_unreadable");
  };
  visit(root);
  for (const path of files) {
    hash.update(relative(root, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(fileDigest(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function boundedFile(path: string): Buffer {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 1024 * 1024) {
      fail("prepared_resource_dependency_closure_invalid");
    }
    return readFileSync(path);
  } catch (error) {
    if (error instanceof PreparedButlerResourceError) throw error;
    fail("prepared_resource_dependency_closure_invalid");
  }
}

function parseJson(bytes: Buffer, code: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code);
  }
}

function fileDigest(path: string): string {
  return digest(readFileSync(path));
}

function digestValues(values: string[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(code: string): never {
  throw new PreparedButlerResourceError(code);
}
