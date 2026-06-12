#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const outDir = resolve(optionValue("--out") ?? "dist/release/app");
const macZip = findOne(/^butler-app-.*-darwin-arm64\.zip$/u);
const linuxTar = findOne(/^butler-app-.*-linux-x64\.tar\.gz$/u);
const releaseManifestPath = join(outDir, "app-release-manifest.json");
const updateManifestPath = join(outDir, "app-update-manifest.json");

for (const path of [macZip, `${macZip}.sha256`, linuxTar, `${linuxTar}.sha256`, releaseManifestPath, updateManifestPath]) {
  if (!existsSync(path)) throw new Error(`missing Butler App release file: ${path}`);
}
verifySha(macZip);
verifySha(linuxTar);
verifyLinuxTar(linuxTar);
verifyMacZip(macZip);

const releaseManifest = JSON.parse(readFileSync(releaseManifestPath, "utf8"));
const updateManifest = JSON.parse(readFileSync(updateManifestPath, "utf8"));
if (releaseManifest.product !== "butler-app") {
  throw new Error(`App release manifest product is wrong: ${String(releaseManifest.product)}`);
}
if (!Array.isArray(updateManifest.artifacts) || updateManifest.artifacts.some((artifact: any) => artifact.product !== "butler-app")) {
  throw new Error("App update manifest includes a non-App artifact");
}

console.log(`Butler App release smoke passed: ${basename(macZip)}, ${basename(linuxTar)}`);

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

function verifySha(path: string): void {
  const expected = readFileSync(`${path}.sha256`, "utf8").trim().split(/\s+/u)[0] ?? "";
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (expected !== actual) {
    throw new Error(`checksum mismatch for ${path}: expected ${expected}, got ${actual}`);
  }
}

function verifyLinuxTar(path: string): void {
  const listing = spawnSync("tar", ["-tzf", path], { encoding: "utf8" });
  if (listing.status !== 0) {
    throw new Error(`Linux App artifact listing failed: ${listing.stderr.trim() || listing.stdout.trim() || "unknown error"}`);
  }
  if (!listing.stdout.includes("Butler-linux-x64/Butler")) {
    throw new Error("Linux App artifact is missing Butler executable");
  }
}

function verifyMacZip(path: string): void {
  if (process.platform !== "darwin") return;
  const extractDir = mkdtempSync(join(tmpdir(), "butler-app-release-smoke-"));
  try {
    const extract = spawnSync("ditto", ["-x", "-k", path, extractDir], { encoding: "utf8" });
    if (extract.status !== 0) {
      throw new Error(`Mac App artifact extraction failed: ${extract.stderr.trim() || extract.stdout.trim() || "unknown error"}`);
    }
    const verify = spawnSync("codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=4",
      join(extractDir, "Butler.app"),
    ], { encoding: "utf8" });
    if (verify.status !== 0) {
      throw new Error(`Mac App codesign verification failed: ${verify.stderr.trim() || verify.stdout.trim() || "unknown error"}`);
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}
