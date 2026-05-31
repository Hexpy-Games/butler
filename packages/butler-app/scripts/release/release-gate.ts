#!/usr/bin/env bun
import { createAppReleaseManifest, validateAppReleaseManifest } from "./manifest.ts";

const root = process.cwd();
const verbose = (process.env.BUTLER_VALIDATE_VERBOSE === "1" || process.argv.includes("--verbose")) &&
  !process.argv.includes("--silent");
const manifest = createAppReleaseManifest(root);
const issues = validateAppReleaseManifest(root, manifest);

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
  console.log(`Protocol: ${manifest.protocol}`);
}
