#!/usr/bin/env bun
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface LinuxServiceInstallerPackageStagingOptions {
  resourceDir: string;
  outDir: string;
  version: string;
  architecture?: "amd64" | "x86_64";
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

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const result = createLinuxServiceInstallerPackageStaging(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(args: string[]): LinuxServiceInstallerPackageStagingOptions {
  let resourceDir = "";
  let outDir = "";
  let version = "";
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
    throw new Error(`unknown option: ${arg}`);
  }
  if (!resourceDir || !outDir || !version) {
    throw new Error("--resource-dir, --out, and --version are required");
  }
  return { resourceDir, outDir, version };
}
