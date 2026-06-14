#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export interface LinuxServiceInstallerPackageStagingOptions {
  resourceDir: string;
  outDir: string;
  version: string;
  architecture?: "amd64" | "x86_64";
}

interface LinuxServiceInstallerPackageCliOptions
  extends LinuxServiceInstallerPackageStagingOptions {
  build: boolean;
}

export interface LinuxServiceInstallerPackageStagingResult {
  debRoot: string;
  rpmRoot: string;
  debControlPath: string;
  debPostinstPath: string;
  rpmSpecPath: string;
  rpmPostinstallPath: string;
  systemdUnitPath: string;
  launcherPath: string;
}

export interface LinuxServiceInstallerPackageBuildResult
  extends LinuxServiceInstallerPackageStagingResult {
  debPackagePath: string;
  debSha256: string;
  debSha256Path: string;
  rpmPackagePath: string;
  rpmSha256: string;
  rpmSha256Path: string;
}

const UNIT_NAME = "butler.service";
const LINUX_PACKAGE_NAME = "butler-app-service";
const SERVICE_UNIT_TARGET = join("usr", "lib", "systemd", "user", UNIT_NAME);
const SERVICE_LAUNCHER_TARGET = join(
  "usr",
  "lib",
  "butler",
  "butler-app-managed-agent-service",
);

export function createLinuxServiceInstallerPackageStaging(
  options: LinuxServiceInstallerPackageStagingOptions,
): LinuxServiceInstallerPackageStagingResult {
  const resourceDir = resolve(options.resourceDir);
  const outDir = resolve(options.outDir);
  const version = options.version.trim();
  if (!version) throw new Error("Linux service installer package version is required");

  const debRoot = join(outDir, "deb-root");
  const rpmRoot = join(outDir, "rpm-root");
  rmSync(debRoot, { recursive: true, force: true });
  rmSync(rpmRoot, { recursive: true, force: true });
  mkdirSync(debRoot, { recursive: true });
  mkdirSync(rpmRoot, { recursive: true });

  const unitBody = linuxSystemdUserUnit();
  const sourceLauncher = join(
    resourceDir,
    "service-installer",
    "linux",
    "launcher",
    "butler-app-managed-agent-service",
  );
  const sourceDebPostinst = join(
    resourceDir,
    "service-installer",
    "linux",
    "deb",
    "postinst",
  );
  const sourceRpmPostinstall = join(
    resourceDir,
    "service-installer",
    "linux",
    "rpm",
    "postinstall.sh",
  );

  const debUnitPath = join(debRoot, SERVICE_UNIT_TARGET);
  const debLauncherPath = join(debRoot, SERVICE_LAUNCHER_TARGET);
  writeText(debUnitPath, unitBody, 0o644);
  copyExecutable(sourceLauncher, debLauncherPath);

  const debControlPath = join(debRoot, "DEBIAN", "control");
  const debPostinstPath = join(debRoot, "DEBIAN", "postinst");
  writeText(debControlPath, debControl({
    version,
    architecture: options.architecture === "x86_64" ? "amd64" : options.architecture ?? "amd64",
  }), 0o644);
  copyExecutable(sourceDebPostinst, debPostinstPath);

  const rpmUnitPath = join(rpmRoot, SERVICE_UNIT_TARGET);
  const rpmLauncherPath = join(rpmRoot, SERVICE_LAUNCHER_TARGET);
  writeText(rpmUnitPath, unitBody, 0o644);
  copyExecutable(sourceLauncher, rpmLauncherPath);

  const rpmPostinstallPath = join(outDir, "rpm", "postinstall.sh");
  const rpmSpecPath = join(outDir, "rpm", `${LINUX_PACKAGE_NAME}.spec`);
  copyExecutable(sourceRpmPostinstall, rpmPostinstallPath);
  writeText(rpmSpecPath, rpmSpec({
    version,
    architecture: options.architecture === "amd64" ? "x86_64" : options.architecture ?? "x86_64",
    postinstallBody: readFileSync(sourceRpmPostinstall, "utf8"),
  }), 0o644);

  return {
    debRoot,
    rpmRoot,
    debControlPath,
    debPostinstPath,
    rpmSpecPath,
    rpmPostinstallPath,
    systemdUnitPath: debUnitPath,
    launcherPath: debLauncherPath,
  };
}

export function buildLinuxServiceInstallerPackages(
  options: LinuxServiceInstallerPackageStagingOptions,
): LinuxServiceInstallerPackageBuildResult {
  const staging = createLinuxServiceInstallerPackageStaging(options);
  const outDir = resolve(options.outDir);
  const version = options.version.trim();
  const debPackagePath = join(outDir, `${LINUX_PACKAGE_NAME}_${version}_amd64.deb`);
  const rpmPackagePath = join(outDir, `${LINUX_PACKAGE_NAME}-${version}-1.x86_64.rpm`);
  runCommand(process.env.BUTLER_APP_DPKG_DEB || "dpkg-deb", [
    "--build",
    "--root-owner-group",
    staging.debRoot,
    debPackagePath,
  ]);

  const rpmTopDir = join(outDir, "rpmbuild");
  const rpmSourcesDir = join(rpmTopDir, "SOURCES");
  const rpmSpecsDir = join(rpmTopDir, "SPECS");
  for (const dir of ["BUILD", "BUILDROOT", "RPMS", "SOURCES", "SPECS", "SRPMS"]) {
    mkdirSync(join(rpmTopDir, dir), { recursive: true });
  }
  copyFileSync(staging.systemdUnitPath, join(rpmSourcesDir, "butler.service"));
  copyFileSync(staging.launcherPath, join(rpmSourcesDir, "butler-app-managed-agent-service"));
  chmodSync(join(rpmSourcesDir, "butler-app-managed-agent-service"), 0o755);
  copyFileSync(staging.rpmSpecPath, join(rpmSpecsDir, `${LINUX_PACKAGE_NAME}.spec`));
  runCommand(process.env.BUTLER_APP_RPMBUILD || "rpmbuild", [
    "--define",
    `_topdir ${rpmTopDir}`,
    "-bb",
    join(rpmSpecsDir, `${LINUX_PACKAGE_NAME}.spec`),
  ]);
  const builtRpm = findBuiltRpm(join(rpmTopDir, "RPMS"));
  copyFileSync(builtRpm, rpmPackagePath);
  const debSha256 = writeSha256File(debPackagePath);
  const rpmSha256 = writeSha256File(rpmPackagePath);

  return {
    ...staging,
    debPackagePath,
    debSha256,
    debSha256Path: `${debPackagePath}.sha256`,
    rpmPackagePath,
    rpmSha256,
    rpmSha256Path: `${rpmPackagePath}.sha256`,
  };
}

function linuxSystemdUserUnit(): string {
  return `[Unit]
Description=Butler Agent background service
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/lib/butler/butler-app-managed-agent-service
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=default.target
`;
}

function debControl(input: { version: string; architecture: string }): string {
  return `Package: ${LINUX_PACKAGE_NAME}
Version: ${input.version}
Section: utils
Priority: optional
Architecture: ${input.architecture}
Maintainer: Hexpy Games <support@hexpy.games>
Description: Butler App background Agent service registration
 Installs the package-owned systemd user unit and launcher used by Butler App.
`;
}

function rpmSpec(input: {
  version: string;
  architecture: string;
  postinstallBody: string;
}): string {
  return `Name: ${LINUX_PACKAGE_NAME}
Version: ${input.version}
Release: 1%{?dist}
Summary: Butler App background Agent service registration
License: Proprietary
BuildArch: ${input.architecture}

%description
Installs the package-owned systemd user unit and launcher used by Butler App.

%install
mkdir -p %{buildroot}/usr/lib/systemd/user
mkdir -p %{buildroot}/usr/lib/butler
cp -p %{_sourcedir}/butler.service %{buildroot}/usr/lib/systemd/user/butler.service
cp -p %{_sourcedir}/butler-app-managed-agent-service %{buildroot}/usr/lib/butler/butler-app-managed-agent-service

%post -p /bin/sh
${input.postinstallBody.trim()}

%files
/usr/lib/systemd/user/butler.service
/usr/lib/butler/butler-app-managed-agent-service
`;
}

function copyExecutable(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  chmodSync(target, 0o755);
}

function writeText(path: string, value: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { encoding: "utf8", mode });
  chmodSync(path, mode);
}

function runCommand(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed: ${
        result.error?.message || result.stderr.trim() || result.stdout.trim() || "unknown error"
      }`,
    );
  }
}

function findBuiltRpm(dir: string): string {
  if (!existsSync(dir)) {
    throw new Error(`rpmbuild output directory is missing: ${dir}`);
  }
  const matches = listFiles(dir).filter((file) => file.endsWith(".rpm")).sort();
  if (matches.length !== 1) {
    throw new Error(`expected exactly one built rpm in ${dir}, got ${matches.length}`);
  }
  return matches[0]!;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function writeSha256File(path: string): string {
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  writeFileSync(`${path}.sha256`, `${sha256}  ${basename(path)}\n`, "utf8");
  return sha256;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const result = args.build
    ? buildLinuxServiceInstallerPackages(args)
    : createLinuxServiceInstallerPackageStaging(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(args: string[]): LinuxServiceInstallerPackageCliOptions {
  let resourceDir = "";
  let outDir = "";
  let version = "";
  let build = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--resource-dir") {
      resourceDir = args[++index] ?? "";
      continue;
    }
    if (arg === "--out") {
      outDir = args[++index] ?? "";
      continue;
    }
    if (arg === "--version") {
      version = args[++index] ?? "";
      continue;
    }
    if (arg === "--build") {
      build = true;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  if (!resourceDir || !outDir || !version) {
    throw new Error("--resource-dir, --out, and --version are required");
  }
  return { resourceDir, outDir, version, build };
}
