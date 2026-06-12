#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import {
  createAppReleaseManifest,
  validateAppReleaseManifest,
  type AppReleaseVersionBaseline,
} from "./manifest.ts";

const root = process.cwd();
const verbose = (process.env.BUTLER_VALIDATE_VERBOSE === "1" || process.argv.includes("--verbose")) &&
  !process.argv.includes("--silent");
const manifest = createAppReleaseManifest(root);
const args = process.argv.slice(2);
const previousManifestArgs = previousManifestPathFromArgs(args);
const allowMissingPreviousManifest =
  args.includes("--allow-missing-previous-manifest") ||
  process.env.BUTLER_APP_ALLOW_MISSING_PREVIOUS_MANIFEST === "1";
const envPreviousManifestPath =
  process.env.BUTLER_APP_PREVIOUS_RELEASE_MANIFEST?.trim() || null;
const previousManifestPath = previousManifestArgs.path ??
  envPreviousManifestPath ??
  null;
const previousManifestResult = previousManifestPath
  ? readPreviousManifest(previousManifestPath)
  : { manifest: null, issue: null };
const issues = [
  ...previousManifestArgs.issues,
  ...(!previousManifestPath && !allowMissingPreviousManifest
    ? ["previous app release manifest is required for App release gate"]
    : []),
  ...(previousManifestResult.issue ? [previousManifestResult.issue] : []),
  ...validateAppReleaseManifest(root, manifest, {
    previousManifest: previousManifestResult.manifest,
  }),
];

if (issues.length > 0) {
  console.error("App release gate failed:");
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

if (verbose) {
  console.log(`App release gate passed: ${manifest.name}@${manifest.version}`);
  console.log(
    `Components: ${manifest.components
      .map((component) => `${component.id}@${component.version}`)
      .join(", ")}`,
  );
  if (previousManifestPath) {
    console.log(`Previous manifest: ${previousManifestPath}`);
  }
  console.log(`Protocol: ${manifest.protocol}`);
}

function previousManifestPathFromArgs(args: string[]): {
  path: string | null;
  issues: string[];
} {
  const issues: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--previous-manifest=")) {
      const path = arg.slice("--previous-manifest=".length).trim();
      if (!path) {
        issues.push("--previous-manifest requires a path");
        return { path: null, issues };
      }
      return { path, issues };
    }
    if (arg === "--previous-manifest") {
      const path = args[index + 1]?.trim() ?? "";
      if (!path || path.startsWith("--")) {
        issues.push("--previous-manifest requires a path");
        return { path: null, issues };
      }
      return { path, issues };
    }
  }
  return { path: null, issues };
}

function readPreviousManifest(path: string): {
  manifest: AppReleaseVersionBaseline | null;
  issue: string | null;
} {
  try {
    return {
      manifest: JSON.parse(readFileSync(path, "utf8")) as AppReleaseVersionBaseline,
      issue: null,
    };
  } catch {
    return {
      manifest: null,
      issue: `previous app release manifest could not be read: ${path}`,
    };
  }
}
