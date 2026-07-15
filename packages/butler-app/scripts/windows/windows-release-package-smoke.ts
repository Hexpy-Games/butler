import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createAppReleasePackage } from "../release/package-app-release.ts";
import { windowsValidationToken } from "./windows-validation-token.ts";
import {
  verifySha256,
  verifySignedWindowsPayload,
} from "./windows-release-verification.ts";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Windows release package smoke requires Windows x64");
}
const validationToken = windowsValidationToken();
if (!validationToken.accepted) {
  throw new Error("Windows release package smoke requires a standard user token");
}
const expectedSignerThumbprint = requireExpectedSignerThumbprint();

const outDir = join(homedir(), ".butler-release-validation", "win32-x64");
rmSync(outDir, { recursive: true, force: true });
const result = createAppReleasePackage({
  root: process.cwd(),
  outDir,
  platforms: ["win32-x64"],
  artifactBaseUrl: "https://updates.invalid/butler/windows",
});
const artifact = result.artifacts[0];
if (!artifact || artifact.platform !== "win32-x64") {
  throw new Error("Windows release package result is missing win32-x64");
}
for (const path of [
  artifact.artifactPath,
  artifact.sha256Path,
  artifact.updaterArtifactPath,
  artifact.updaterSha256Path,
  artifact.updaterIndexPath,
  artifact.updaterIndexSha256Path,
  result.releaseManifestPath,
  result.updateManifestPath,
]) {
  if (!path || !existsSync(path)) {
    throw new Error("Windows release package output is incomplete");
  }
}
verifySha256(artifact.artifactPath, artifact.sha256Path);
verifySha256(artifact.updaterArtifactPath!, artifact.updaterSha256Path!);
verifySha256(artifact.updaterIndexPath!, artifact.updaterIndexSha256Path!);
const signedPayload = verifySignedWindowsPayload({
  expectedSignerThumbprint,
  packagePath: artifact.updaterArtifactPath!,
  setupPath: artifact.artifactPath,
});

const releaseManifest = JSON.parse(
  readFileSync(result.releaseManifestPath, "utf8"),
);
const updateManifest = JSON.parse(
  readFileSync(result.updateManifestPath, "utf8"),
);
const releaseArtifact = releaseManifest.artifacts?.[0];
const updateArtifact = updateManifest.artifacts?.[0];
if (
  releaseArtifact?.platform !== "win32-x64" ||
  releaseArtifact?.distributionStatus !== "gated" ||
  releaseArtifact?.updateFeed?.kind !== "squirrel-windows" ||
  updateArtifact?.distribution_status !== "gated" ||
  updateArtifact?.update_feed?.kind !== "squirrel-windows"
) {
  throw new Error("Windows release and updater manifests are inconsistent");
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  platform: "win32-x64",
  standardUser: validationToken.standardUser,
  ciElevatedToken: validationToken.ciElevatedToken,
  distributionStatus: "gated",
  setup: basename(artifact.artifactPath),
  updatePackage: basename(artifact.updaterArtifactPath!),
  updateIndex: basename(artifact.updaterIndexPath!),
  checksumsVerified: true,
  signaturesVerified: true,
  signedPayload: signedPayload.required,
  signedPeCount: signedPayload.peCount,
  rawTextIncluded: false,
})}\n`);

function requireExpectedSignerThumbprint(): string {
  const value = process.env.BUTLER_WINDOWS_SIGN_CERTIFICATE_SHA1
    ?.trim()
    .toUpperCase();
  if (!value || !/^[A-F0-9]{40}$/u.test(value)) {
    throw new Error("Windows release package smoke requires a signing thumbprint");
  }
  return value;
}
