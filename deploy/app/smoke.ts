#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const outDir = resolve(optionValue("--out") ?? "dist/release/app");
const macPkg = findOne(/^butler-app-.*-darwin-arm64\.pkg$/u);
const linuxTar = findOne(/^butler-app-.*-linux-x64\.tar\.gz$/u);
const releaseManifestPath = join(outDir, "app-release-manifest.json");
const updateManifestPath = join(outDir, "app-update-manifest.json");

for (const path of [macPkg, `${macPkg}.sha256`, linuxTar, `${linuxTar}.sha256`, releaseManifestPath, updateManifestPath]) {
  if (!existsSync(path)) throw new Error(`missing Butler App release file: ${path}`);
}
verifySha(macPkg);
verifySha(linuxTar);
verifyLinuxTar(linuxTar);
verifyMacPkg(macPkg);

const releaseManifest = JSON.parse(readFileSync(releaseManifestPath, "utf8"));
const updateManifest = JSON.parse(readFileSync(updateManifestPath, "utf8"));
if (releaseManifest.product !== "butler-app") {
  throw new Error(`App release manifest product is wrong: ${String(releaseManifest.product)}`);
}
if (!Array.isArray(updateManifest.artifacts) || updateManifest.artifacts.some((artifact: any) => artifact.product !== "butler-app")) {
  throw new Error("App update manifest includes a non-App artifact");
}

console.log(`Butler App release smoke passed: ${basename(macPkg)}, ${basename(linuxTar)}`);

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

function verifyMacPkg(path: string): void {
  if (process.platform !== "darwin") return;
  const tempRoot = mkdtempSync(join(tmpdir(), "butler-app-release-smoke-"));
  const extractDir = join(tempRoot, "expanded");
  try {
    const extract = spawnSync("pkgutil", ["--expand-full", path, extractDir], { encoding: "utf8" });
    if (extract.status !== 0) {
      throw new Error(`Mac App pkg extraction failed: ${extract.stderr.trim() || extract.stdout.trim() || "unknown error"}`);
    }
    const payloadRoot = join(extractDir, "Payload");
    const appPath = join(payloadRoot, "Applications", "Butler.app");
    if (!existsSync(appPath)) {
      throw new Error("Mac App pkg is missing Applications/Butler.app payload");
    }
    const postinstallPath = join(extractDir, "Scripts", "postinstall");
    if (!existsSync(postinstallPath)) {
      throw new Error("Mac App pkg is missing postinstall service hook");
    }
    if ((statSync(postinstallPath).mode & 0o111) === 0) {
      throw new Error("Mac App pkg postinstall service hook is not executable");
    }
    const verify = spawnSync("codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=4",
      appPath,
    ], { encoding: "utf8" });
    if (verify.status !== 0) {
      throw new Error(`Mac App codesign verification failed: ${verify.stderr.trim() || verify.stdout.trim() || "unknown error"}`);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
