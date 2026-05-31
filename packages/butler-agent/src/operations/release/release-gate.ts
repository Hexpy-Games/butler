#!/usr/bin/env bun
import { createReleaseManifest, validateReleaseManifest } from "./manifest.ts";

const root = process.cwd();
const verbose = (process.env.BUTLER_VALIDATE_VERBOSE === "1" || process.argv.includes("--verbose")) &&
  !process.argv.includes("--silent");
const manifest = createReleaseManifest(root);
const issues = validateReleaseManifest(root, manifest);

if (issues.length > 0) {
  console.error("Service release gate failed:");
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

if (verbose) {
  console.log(`Service release gate passed: ${manifest.name}@${manifest.version}`);
  console.log(
    `Components: ${manifest.components
      .map((component) => `${component.id}@${component.version}`)
      .join(", ")}`,
  );
  console.log(`Managed runtime: Bun ${manifest.managedRuntimeVersion}`);
}
