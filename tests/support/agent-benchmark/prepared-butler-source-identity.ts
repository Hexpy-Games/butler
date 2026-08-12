import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const AGENT_PACKAGE_INPUTS = [
  "package.json", "bun.lock", "bin/butler.js", "install.sh",
  "butler.config.template.json", "LICENSE", "deploy/agent",
  "packages/butler-agent/src", "packages/butler-agent/scripts",
  "packages/butler-agent/resources", "packages/butler-progress-projection",
  "packages/project-ledger", "VERSION", "README.md",
] as const;

// buildAppWebClientDist consumes this complete source/config tree. Generated
// dist and installed node_modules are excluded by hashPath.
const RENDERER_BUILD_INPUTS = ["packages/butler-app/client/ui"] as const;

// Transitive non-generated inputs of prepareBundledAgentResource:
// package-app-release -> release/manifest -> background-service-contract, plus
// its direct PowerShell environment import and createAppReleaseManifest's
// Electron package version input.
const APP_BUNDLED_RESOURCE_PRODUCER_INPUTS = [
  "packages/butler-app/scripts/release",
  "packages/butler-app/scripts/background-service-contract.ts",
  "packages/butler-app/client/electron/package.json",
  "packages/butler-app/client/electron/windows-powershell-environment.mjs",
] as const;

const SOURCE_INPUTS = [
  ...AGENT_PACKAGE_INPUTS,
  ...RENDERER_BUILD_INPUTS,
  ...APP_BUNDLED_RESOURCE_PRODUCER_INPUTS,
] as const;

export function sourceCompatibilitySha256(sourceRoot: string): string {
  const root = resolve(sourceRoot);
  const hash = createHash("sha256");
  for (const relativePath of SOURCE_INPUTS) hashPath(hash, root, join(root, relativePath));
  return hash.digest("hex");
}

export function sourceRevision(root: string): string | null {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function hashPath(
  hash: ReturnType<typeof createHash>,
  root: string,
  path: string,
): void {
  const stat = lstatSync(path);
  const label = relative(root, path).replaceAll("\\", "/");
  if (stat.isSymbolicLink()) throw new Error("source input is symlinked");
  if (stat.isFile()) {
    hash.update(`file\0${label}\0${stat.mode & 0o7777}\0`);
    hash.update(readFileSync(path));
    return;
  }
  if (!stat.isDirectory()) throw new Error("source input is not a regular file or directory");
  hash.update(`dir\0${label}\0`);
  for (const entry of readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.name !== "node_modules" && entry.name !== "dist")
    .sort((left, right) => left.name.localeCompare(right.name))) {
    hashPath(hash, root, join(path, entry.name));
  }
}
