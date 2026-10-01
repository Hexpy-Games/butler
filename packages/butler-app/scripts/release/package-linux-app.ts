#!/usr/bin/env bun
/**
 * Linux App packages (#260 Linux track): the Electron App with the native
 * Butler Agent bundled the way macOS bundles it, as a DEB (x64, arm64) and an
 * Arch pacman package (x64). The App starts the agent in its own POSIX process
 * group while it is open; no systemd unit is installed.
 *
 * Usage (on a Linux host of the target architecture):
 *   bun run packages/butler-app/scripts/release/package-linux-app.ts \
 *     --platform=linux-x64 --format=deb --format=pacman --out dist/release/app-linux
 *
 * A prebuilt agent passed in BUTLER_NATIVE_AGENT_EXECUTABLE skips the cargo
 * build (see prepare-native-agent.mjs).
 */
import { stageElectronPackageSource } from "./electron-package-source.ts";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  lstatSync,
  lutimesSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { readAppComponentVersions } from "./manifest.ts";

export type LinuxAppPlatform = "linux-x64" | "linux-arm64";
export type LinuxPackageFormat = "deb" | "pacman";

export interface LinuxPackageArtifact {
  platform: LinuxAppPlatform;
  format: LinuxPackageFormat;
  artifactPath: string;
  sha256: string;
}

interface StagedApp {
  root: string;
  platform: LinuxAppPlatform;
  version: string;
  packagedDir: string;
  agentBinary: string;
  appBinary: string;
  /** SOURCE_DATE_EPOCH (seconds): the fixed mtime and the reproducible-build clock. */
  epoch: number;
}

const ELECTRON_ROOT = join("packages", "butler-app", "client", "electron");
const APP_RENDERER_DIST = join("packages", "butler-app", "client", "ui", "dist");
/** Where the packages install the App; the agent's installation root. */
export const LINUX_INSTALL_ROOT = "/opt/butler";
const PACKAGE_NAME = "butler-app";
const DEB_ARCHITECTURES: Record<LinuxAppPlatform, string> = { "linux-x64": "amd64", "linux-arm64": "arm64" };
const HOST_PLATFORMS: Record<string, LinuxAppPlatform> = { x64: "linux-x64", arm64: "linux-arm64" };

/** Builds the requested packages for one platform and returns them with digests. */
export function createLinuxAppPackages(input: {
  root: string;
  outDir: string;
  platform: LinuxAppPlatform;
  formats: LinuxPackageFormat[];
}): LinuxPackageArtifact[] {
  const root = resolve(input.root);
  const outDir = resolve(input.outDir);
  if (process.platform !== "linux" || HOST_PLATFORMS[process.arch] !== input.platform) {
    throw new Error(`${input.platform} App packages must be built on a ${input.platform} host`);
  }
  if (input.formats.includes("pacman") && input.platform !== "linux-x64") {
    throw new Error("pacman App packages support linux-x64 only");
  }
  mkdirSync(outDir, { recursive: true });
  const epoch = sourceDateEpoch(root);
  process.env.SOURCE_DATE_EPOCH = String(epoch);
  const workDir = mkdtempSync(join(tmpdir(), "butler-linux-app-"));
  try {
    const staged = packageElectronApp(root, workDir, input.platform, epoch);
    return input.formats.map((format) => {
      const artifactPath = join(outDir, artifactName(staged, format));
      if (format === "deb") createDeb(staged, workDir, artifactPath);
      else createPacman(staged, workDir, artifactPath);
      const sha256 = sha256File(artifactPath);
      writeFileSync(`${artifactPath}.sha256`, `${sha256}  ${basename(artifactPath)}\n`, "utf8");
      return { platform: input.platform, format, artifactPath, sha256 };
    });
  } finally {
    makeTreeWritable(workDir);
    rmSync(workDir, { recursive: true, force: true });
  }
}

function artifactName(staged: StagedApp, format: LinuxPackageFormat): string {
  return format === "deb"
    ? `${PACKAGE_NAME}-${staged.version}-${staged.platform}.deb`
    : `${PACKAGE_NAME}-${staged.version}-archlinux-x64.pkg.tar.zst`;
}

/** Prepares the native agent payload and runs electron-packager with it. */
function packageElectronApp(root: string, workDir: string, platform: LinuxAppPlatform, epoch: number): StagedApp {
  const versions = readAppComponentVersions(root);
  const arch = platform === "linux-x64" ? "x64" : "arm64";
  const agentDir = join(workDir, "bundled-agent");
  run(process.env.BUTLER_NODE || "node", [
    join(root, ELECTRON_ROOT, "scripts", "prepare-native-agent.mjs"), "linux", arch, agentDir,
  ], { cwd: root, env: { ...process.env, BUTLER_NATIVE_PAYLOAD_WRITABLE: "1", BUTLER_PACKAGED_APP_VERSION: versions.app } });
  const manifest = JSON.parse(readFileSync(join(agentDir, "native-agent-manifest.json"), "utf8"));
  if (manifest.version !== versions.bundledAgent || manifest.appVersion !== versions.app) {
    throw new Error("native bundled Agent version does not match the App release");
  }
  const rendererDist = join(root, APP_RENDERER_DIST);
  if (!existsSync(join(rendererDist, "index.html"))) {
    throw new Error(`Butler app renderer dist is missing: ${rendererDist}`);
  }
  const rendererDir = join(workDir, "app-client");
  cpSync(rendererDist, rendererDir, { recursive: true });
  const packagerCli = join(root, ELECTRON_ROOT, "node_modules", "@electron", "packager", "bin", "electron-packager.mjs");
  if (!existsSync(packagerCli)) {
    throw new Error("Electron packager is missing; run bun install --frozen-lockfile --ignore-scripts");
  }
  const electronVersion = JSON.parse(readFileSync(join(root, ELECTRON_ROOT, "package.json"), "utf8")).devDependencies.electron;
  const packageOut = join(workDir, "electron");
  run(process.env.BUTLER_NODE || "node", [
    packagerCli, stageElectronPackageSource(root, join(workDir, "electron-source")), "Butler", "--platform=linux", `--arch=${arch}`, "--overwrite",
    `--out=${packageOut}`, `--electron-version=${electronVersion}`, `--icon=${join(root, ELECTRON_ROOT, "assets", "icon.png")}`,
    `--extra-resource=${agentDir}`, `--extra-resource=${rendererDir}`,
    "--ignore=^/(dist|.native-agent-payload)($|/)", "--quiet",
  ], { cwd: root });
  const packagedDir = join(packageOut, `Butler-${platform}`);
  const agentBinary = join(packagedDir, "resources", "bundled-agent", "bin", "butler-agent");
  if (!existsSync(join(packagedDir, "Butler")) || !existsSync(agentBinary)) {
    throw new Error(`electron package is incomplete: ${packagedDir}`);
  }
  run(process.env.BUTLER_NODE || "node", [join(root, ELECTRON_ROOT, "scripts", "prepare-process-links.mjs"), agentBinary], { cwd: root });
  run(process.env.BUTLER_NODE || "node", [join(root, "deploy/licenses/package-app.mjs"), packagedDir], { cwd: root });
  return { root, platform, version: versions.app, packagedDir, agentBinary, appBinary: join(packagedDir, "Butler"), epoch };
}

/** Lays out the file system every package format installs. */
function stagePackageRoot(staged: StagedApp, packageRoot: string, format: LinuxPackageFormat): string {
  const installDir = join(LINUX_INSTALL_ROOT, `Butler-${staged.platform}`);
  const target = join(packageRoot, installDir.slice(1));
  mkdirSync(join(target, ".."), { recursive: true });
  cpSync(staged.packagedDir, target, { recursive: true, dereference: false });
  normalizeModes(target);
  run(process.env.BUTLER_NODE || "node", [
    join(staged.root, ELECTRON_ROOT, "scripts", "prepare-process-links.mjs"),
    join(target, "resources", "bundled-agent", "bin", "butler-agent"),
  ], { cwd: staged.root });
  // Electron's sandbox helper must be setuid root; both formats install as root.
  chmodSync(join(target, "chrome-sandbox"), 0o4755);
  const binDir = join(packageRoot, "usr", "bin");
  const shareDir = join(packageRoot, "usr", "share");
  for (const dir of [binDir, join(shareDir, "applications"), join(shareDir, "icons", "hicolor", "512x512", "apps"),
    format === "deb" ? join(shareDir, "doc", PACKAGE_NAME) : join(shareDir, "licenses", PACKAGE_NAME)]) {
    mkdirSync(dir, { recursive: true });
  }
  writeExecutable(join(binDir, PACKAGE_NAME), launcherScript(installDir));
  copyFileSync(join(staged.root, ELECTRON_ROOT, "assets", "icon.png"), join(shareDir, "icons", "hicolor", "512x512", "apps", "butler.png"));
  // Debian policy: the license text is /usr/share/doc/<package>/copyright.
  const license = join(staged.root, "LICENSE");
  if (format === "deb") copyFileSync(license, join(shareDir, "doc", PACKAGE_NAME, "copyright"));
  else copyFileSync(license, join(shareDir, "licenses", PACKAGE_NAME, "LICENSE"));
  writeFileSync(join(shareDir, "applications", "butler.desktop"), desktopEntry(), "utf8");
  // Reproducible packages: every staged entry carries the source date.
  setTreeMtime(packageRoot, staged.epoch);
  return installDir;
}

function createDeb(staged: StagedApp, workDir: string, artifactPath: string): void {
  const debRoot = join(workDir, "deb-root");
  const controlDir = join(debRoot, "DEBIAN");
  mkdirSync(controlDir, { recursive: true });
  const installDir = stagePackageRoot(staged, debRoot, "deb");
  writeFileSync(join(controlDir, "control"), debControl(staged), "utf8");
  writeExecutable(join(controlDir, "postinst"), postInstallScript(installDir));
  setTreeMtime(controlDir, staged.epoch);
  rmSync(artifactPath, { force: true });
  run(process.env.BUTLER_APP_DPKG_DEB || "dpkg-deb", ["--build", "--root-owner-group", "-Zxz", debRoot, artifactPath]);
}

function createPacman(staged: StagedApp, workDir: string, artifactPath: string): void {
  const buildDir = join(workDir, "pacman");
  mkdirSync(buildDir, { recursive: true });
  const installDir = stagePackageRoot(staged, join(buildDir, "pkgroot"), "pacman");
  writeFileSync(join(buildDir, "PKGBUILD"), pkgbuild(staged, installDir), "utf8");
  writeFileSync(join(buildDir, `${PACKAGE_NAME}.install`), pacmanInstallHooks(installDir), "utf8");
  setTreeMtime(buildDir, staged.epoch);
  run(process.env.BUTLER_APP_MAKEPKG || "makepkg", ["--force", "--nodeps"], {
    cwd: buildDir,
    env: { ...process.env, PKGEXT: ".pkg.tar.zst", PKGDEST: buildDir },
  });
  const built = join(buildDir, `${PACKAGE_NAME}-${staged.version}-1-x86_64.pkg.tar.zst`);
  if (!existsSync(built)) throw new Error(`pacman package was not created: ${built}`);
  copyFileSync(built, artifactPath);
}

/**
 * The glibc floor of the package: the highest GLIBC_x.y symbol version needed
 * by the bundled agent or the Butler (Electron) binary, so a DEB never installs
 * where either cannot start.
 */
function glibcFloor(...binaries: string[]): string {
  const numbers = binaries.flatMap((binary) =>
    (run("readelf", ["--version-info", "--wide", binary]).match(/GLIBC_\d+\.\d+(?:\.\d+)?/gu) ?? [])
      .map((name) => name.slice("GLIBC_".length).split(".").map(Number)));
  numbers.sort((left, right) => compareVersions(right, left));
  return numbers[0]?.join(".") ?? "2.17";
}

/** SOURCE_DATE_EPOCH if set, otherwise the commit time of the checkout. */
function sourceDateEpoch(root: string): number {
  const configured = Number(process.env.SOURCE_DATE_EPOCH);
  if (Number.isInteger(configured) && configured > 0) return configured;
  const committed = Number(run("git", ["log", "-1", "--format=%ct"], { cwd: root }).trim());
  if (!Number.isInteger(committed) || committed <= 0) {
    throw new Error("cannot determine SOURCE_DATE_EPOCH; set it or build from a git checkout");
  }
  return committed;
}

/** Sets the modification time of a tree (symlinks included, not followed). */
function setTreeMtime(path: string, epoch: number): void {
  lutimesSync(path, epoch, epoch);
  if (!lstatSync(path).isDirectory()) return;
  for (const entry of readdirSync(path)) setTreeMtime(join(path, entry), epoch);
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function debControl(staged: StagedApp): string {
  return `Package: ${PACKAGE_NAME}
Version: ${staged.version}
Section: utils
Priority: optional
Architecture: ${DEB_ARCHITECTURES[staged.platform]}
Maintainer: Hexpy Games <support@hexpy.games>
Homepage: https://github.com/Hexpy-Games/butler
Depends: libc6 (>= ${glibcFloor(staged.agentBinary, staged.appBinary)}), libstdc++6, libgcc-s1, libgtk-3-0t64 | libgtk-3-0, libnss3, libxss1, libasound2t64 | libasound2, libgbm1, libnotify4, xdg-utils
Description: Butler desktop app
 Butler desktop app with the bundled native Butler Agent. The agent runs
 while the app is open.
`;
}

function pkgbuild(staged: StagedApp, installDir: string): string {
  return `pkgname=${PACKAGE_NAME}
pkgver=${staged.version}
pkgrel=1
pkgdesc='Butler desktop app with the bundled native Butler Agent'
arch=('x86_64')
url='https://github.com/Hexpy-Games/butler'
license=('MIT')
depends=('glibc' 'gcc-libs' 'gtk3' 'nss' 'libxss' 'alsa-lib' 'mesa' 'libnotify' 'xdg-utils')
options=('!strip' '!debug')
install=${PACKAGE_NAME}.install

package() {
  cp -a "$startdir/pkgroot/." "$pkgdir/"
  chmod 4755 "$pkgdir${installDir}/chrome-sandbox"
}
`;
}

function pacmanInstallHooks(installDir: string): string {
  return `post_install() {
  chmod 4755 "${installDir}/chrome-sandbox" 2>/dev/null || true
  echo "Butler installed. Start it from the app menu or run: butler-app"
}

post_upgrade() {
  post_install
}
`;
}

function postInstallScript(installDir: string): string {
  return `#!/bin/sh
set -eu
# Electron's setuid sandbox helper must be root-owned and setuid.
chmod 4755 "${installDir}/chrome-sandbox" 2>/dev/null || true
echo "Butler installed. Start it from the app menu or run: butler-app"
exit 0
`;
}

function launcherScript(installDir: string): string {
  return `#!/bin/sh
# Starts the Butler App; the App starts the bundled Butler Agent.
set -eu
if [ "\${BUTLER_APP_ENABLE_GPU:-0}" = "1" ]; then
  exec "${installDir}/Butler" "$@"
fi
exec "${installDir}/Butler" --disable-gpu --disable-gpu-compositing "$@"
`;
}

function desktopEntry(): string {
  return `[Desktop Entry]
Type=Application
Name=Butler
Comment=Butler desktop app
Exec=${PACKAGE_NAME} %U
Icon=butler
Terminal=false
Categories=Utility;Development;
StartupWMClass=Butler
`;
}

/** Directories 755, executables 755, other files 644 (the payload ships read-only). */
function normalizeModes(path: string): void {
  chmodSync(path, 0o755);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) normalizeModes(child);
    else if (entry.isFile()) chmodSync(child, statSync(child).mode & 0o111 ? 0o755 : 0o644);
  }
}

function makeTreeWritable(path: string): void {
  if (!existsSync(path)) return;
  try {
    chmodSync(path, 0o755);
  } catch {
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) makeTreeWritable(join(path, entry.name));
  }
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status === 0) return result.stdout;
  const detail = (result.stderr || result.stdout || result.error?.message || "unknown error").trim();
  throw new Error(`${basename(command)} ${args[0] ?? ""} failed: ${detail.slice(-4000)}`);
}

function parseCliArgs(args: string[]): { platform: LinuxAppPlatform; formats: LinuxPackageFormat[]; outDir: string } {
  let platform: LinuxAppPlatform | undefined = HOST_PLATFORMS[process.arch];
  const formats: LinuxPackageFormat[] = [];
  let outDir = join(process.cwd(), "dist", "release", "app-linux");
  for (const arg of args) {
    const [name, value = ""] = arg.split("=", 2);
    if (name === "--platform" && (value === "linux-x64" || value === "linux-arm64")) platform = value;
    else if (name === "--format" && (value === "deb" || value === "pacman")) formats.push(value);
    else if (name === "--out" && value.trim()) outDir = value;
    else throw new Error(`unknown or invalid option: ${arg}`);
  }
  if (!platform) throw new Error("--platform=linux-x64|linux-arm64 is required on this host");
  return { platform, formats: formats.length ? formats : ["deb"], outDir };
}

if (import.meta.main) {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    for (const artifact of createLinuxAppPackages({ root: process.cwd(), ...args })) {
      process.stdout.write(`Linux App package (${artifact.format}): ${artifact.artifactPath}\nSHA256: ${artifact.sha256}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
