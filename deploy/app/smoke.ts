#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const outDir = resolve(optionValue("--out") ?? "dist/release/app");
const macDmg = findOne(/^butler-app-.*-darwin-arm64\.dmg$/u);
const macZip = findOne(/^butler-app-.*-darwin-arm64\.zip$/u);
const linuxX64Deb = findOne(/^butler-app-.*-linux-x64\.deb$/u);
const linuxArm64Deb = findOne(/^butler-app-.*-linux-arm64\.deb$/u);
const releaseManifestPath = join(outDir, "app-release-manifest.json");
const updateManifestPath = join(outDir, "app-update-manifest.json");

for (const path of [
  macDmg,
  `${macDmg}.sha256`,
  macZip,
  `${macZip}.sha256`,
  linuxX64Deb,
  `${linuxX64Deb}.sha256`,
  linuxArm64Deb,
  `${linuxArm64Deb}.sha256`,
  releaseManifestPath,
  updateManifestPath,
]) {
  if (!existsSync(path)) throw new Error(`missing Butler App release file: ${path}`);
}
verifySha(macDmg);
verifySha(macZip);
verifySha(linuxX64Deb);
verifySha(linuxArm64Deb);
verifyLinuxDeb(linuxX64Deb, "linux-x64");
verifyLinuxDeb(linuxArm64Deb, "linux-arm64");
verifyMacArtifacts(macDmg, macZip);

const releaseManifest = JSON.parse(readFileSync(releaseManifestPath, "utf8"));
const updateManifest = JSON.parse(readFileSync(updateManifestPath, "utf8"));
if (releaseManifest.product !== "butler-app") {
  throw new Error(`App release manifest product is wrong: ${String(releaseManifest.product)}`);
}
if (!Array.isArray(updateManifest.artifacts) || updateManifest.artifacts.some((artifact: any) => artifact.product !== "butler-app")) {
  throw new Error("App update manifest includes a non-App artifact");
}

console.log(
  `Butler App release smoke passed: ${basename(macDmg)}, ${basename(macZip)}, ${basename(linuxX64Deb)}, ${basename(linuxArm64Deb)}`,
);

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

function verifyLinuxDeb(path: string, platform: "linux-x64" | "linux-arm64"): void {
  const listing = spawnSync("dpkg-deb", ["-c", path], { encoding: "utf8" });
  if (listing.status !== 0) {
    throw new Error(`Linux App artifact listing failed: ${listing.stderr.trim() || listing.stdout.trim() || "unknown error"}`);
  }
  if (!listing.stdout.includes(`./opt/butler/Butler-${platform}/Butler`)) {
    throw new Error("Linux App artifact is missing Butler executable");
  }
  if (!listing.stdout.includes("./usr/bin/butler-app")) {
    throw new Error("Linux App artifact is missing butler-app launcher");
  }
  if (!listing.stdout.includes("/resources/bundled-agent/")) {
    throw new Error("Linux App artifact is missing the bundled Agent payload");
  }
  if (listing.stdout.includes("./usr/lib/systemd/user/butler.service")) {
    throw new Error("Linux App artifact must not include the retired systemd user service unit");
  }
  if (listing.stdout.includes("./usr/lib/butler/butler-app-managed-agent-service")) {
    throw new Error("Linux App artifact must not include the retired Agent service launcher");
  }
}

type MacReleaseSmokeMode = "ad-hoc" | "production";

function verifyMacArtifacts(dmgPath: string, zipPath: string): void {
  if (process.platform !== "darwin") return;
  const mode = macReleaseSmokeMode();
  verifyMacDmg(dmgPath, mode);
  verifyMacZip(zipPath, mode);
}

function macReleaseSmokeMode(): MacReleaseSmokeMode {
  const requested = process.env.BUTLER_APP_RELEASE_SMOKE_MODE?.trim();
  const productionSigningRequired = process.env.BUTLER_APP_REQUIRE_PRODUCTION_SIGNING === "1";
  if (requested && requested !== "ad-hoc" && requested !== "production") {
    throw new Error(
      `BUTLER_APP_RELEASE_SMOKE_MODE must be ad-hoc or production, got ${requested}`,
    );
  }
  if (productionSigningRequired && requested === "ad-hoc") {
    throw new Error(
      "BUTLER_APP_RELEASE_SMOKE_MODE=ad-hoc cannot be used with production signing",
    );
  }
  const mode = productionSigningRequired || requested === "production"
    ? "production"
    : requested ?? "ad-hoc";
  if (mode === "production") {
    if (!process.env.BUTLER_APP_SIGN_IDENTITY?.trim()) {
      throw new Error("BUTLER_APP_SIGN_IDENTITY is required for production macOS release smoke");
    }
    if (!process.env.BUTLER_APP_NOTARY_KEYCHAIN_PROFILE?.trim()) {
      throw new Error(
        "BUTLER_APP_NOTARY_KEYCHAIN_PROFILE is required for production macOS release smoke",
      );
    }
  }
  return mode;
}

function verifyMacDmg(path: string, mode: MacReleaseSmokeMode): void {
  if (process.platform !== "darwin") return;
  const tempRoot = mkdtempSync(join(tmpdir(), "butler-app-release-smoke-"));
  const mountPoint = join(tempRoot, "mounted");
  mkdirSync(mountPoint);
  let attached = false;
  try {
    if (mode === "production") {
      verifyMacCodeSignature(path, "Mac App DMG container");
      verifyMacStapling(path, "Mac App DMG container");
    }
    const attach = spawnSync("hdiutil", [
      "attach",
      "-nobrowse",
      "-readonly",
      "-mountpoint",
      mountPoint,
      path,
    ], { encoding: "utf8" });
    if (attach.status !== 0) {
      throw new Error(
        `Mac App DMG mount failed: ${attach.stderr.trim() || attach.stdout.trim() || "unknown error"}`,
      );
    }
    attached = true;
    const appEntries = readdirSync(mountPoint).filter((name) => name.endsWith(".app"));
    if (appEntries.length !== 1 || appEntries[0] !== "Butler.app") {
      throw new Error("Mac App DMG must contain exactly one Butler.app");
    }
    const applicationsLink = join(mountPoint, "Applications");
    if (
      !existsSync(applicationsLink) ||
      !lstatSync(applicationsLink).isSymbolicLink() ||
      readlinkSync(applicationsLink) !== "/Applications"
    ) {
      throw new Error("Mac App DMG is missing the Applications link");
    }
    const appPath = join(mountPoint, "Butler.app");
    verifyMacCodeSignature(appPath, "Mac App DMG Butler.app");
    if (mode === "production") {
      verifyMacStapling(appPath, "Mac App DMG Butler.app");
    }
    const detach = spawnSync("hdiutil", ["detach", mountPoint], { encoding: "utf8" });
    if (detach.status !== 0) {
      throw new Error(
        `Mac App DMG detach failed: ${detach.stderr.trim() || detach.stdout.trim() || "unknown error"}`,
      );
    }
    attached = false;
  } finally {
    if (attached) {
      spawnSync("hdiutil", ["detach", mountPoint], { encoding: "utf8" });
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function verifyMacZip(path: string, mode: MacReleaseSmokeMode): void {
  if (process.platform !== "darwin") return;
  const extractDir = mkdtempSync(join(tmpdir(), "butler-app-release-zip-smoke-"));
  try {
    const extract = spawnSync("ditto", ["-x", "-k", path, extractDir], { encoding: "utf8" });
    if (extract.status !== 0) {
      throw new Error(
        `Mac App zip extraction failed: ${extract.stderr.trim() || extract.stdout.trim() || "unknown error"}`,
      );
    }
    const appPath = join(extractDir, "Butler.app");
    if (!existsSync(appPath)) throw new Error("Mac App zip is missing Butler.app");
    verifyMacCodeSignature(appPath, "Mac App ZIP Butler.app");
    if (mode === "production") {
      verifyMacStapling(appPath, "Mac App ZIP Butler.app");
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

function verifyMacCodeSignature(appPath: string, label = "Mac App"): void {
  const verify = spawnSync("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=4",
    appPath,
  ], { encoding: "utf8" });
  if (verify.status !== 0) {
    throw new Error(
      `${label} codesign verification failed: ${verify.stderr.trim() || verify.stdout.trim() || "unknown error"}`,
    );
  }
}

function verifyMacStapling(path: string, label: string): void {
  const validate = spawnSync("xcrun", ["stapler", "validate", path], { encoding: "utf8" });
  if (validate.status !== 0) {
    throw new Error(
      `${label} notarization staple validation failed: ${validate.stderr.trim() || validate.stdout.trim() || "unknown error"}`,
    );
  }
}
