#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const outDir = resolve(optionValue("--out") ?? "dist/release/agent");
const artifactPath = findOne(/^butler-agent-.*-all\.tar\.gz$/u);
const shaPath = `${artifactPath}.sha256`;
const releaseManifestPath = join(outDir, "agent-release-manifest.json");
const updateManifestPath = join(outDir, "agent-update-manifest.json");

for (const path of [artifactPath, shaPath, releaseManifestPath, updateManifestPath]) {
  if (!existsSync(path)) throw new Error(`missing Butler Agent release file: ${path}`);
}

const expectedSha = readFileSync(shaPath, "utf8").trim().split(/\s+/u)[0] ?? "";
const actualSha = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
if (expectedSha !== actualSha) {
  throw new Error(`Butler Agent artifact checksum mismatch: expected ${expectedSha}, got ${actualSha}`);
}

const listing = spawnSync("tar", ["-tzf", artifactPath], { encoding: "utf8" });
if (listing.status !== 0) {
  throw new Error(`Butler Agent artifact listing failed: ${listing.stderr.trim() || listing.stdout.trim() || "unknown error"}`);
}
for (const requiredEntry of [
  "./install.sh",
  "./package.json",
  "./bin/butler.js",
  "./deploy/agent/package-agent.ts",
  "./packages/butler-agent/resources/app-client/dist/index.html",
]) {
  if (!listing.stdout.includes(requiredEntry)) {
    throw new Error(`Butler Agent artifact is missing ${requiredEntry}`);
  }
}
if (!listing.stdout.includes("./packages/butler-agent/resources/app-client/dist/assets/")) {
  throw new Error("Butler Agent artifact is missing built Butler App web client assets");
}

const releaseManifest = JSON.parse(readFileSync(releaseManifestPath, "utf8"));
const updateManifest = JSON.parse(readFileSync(updateManifestPath, "utf8"));
if (releaseManifest.product !== "butler-agent") {
  throw new Error(`Agent release manifest product is wrong: ${String(releaseManifest.product)}`);
}
if (!Array.isArray(updateManifest.artifacts) || updateManifest.artifacts[0]?.product !== "butler-agent") {
  throw new Error("Agent update manifest does not expose a Butler Agent artifact");
}

console.log(`Butler Agent release smoke passed: ${basename(artifactPath)}`);

function optionValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function findOne(pattern: RegExp): string {
  const matches = readdirSync(outDir).filter((name) => pattern.test(name)).sort();
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${pattern} in ${outDir}, got ${matches.length}`);
  }
  return join(outDir, matches[0]!);
}
