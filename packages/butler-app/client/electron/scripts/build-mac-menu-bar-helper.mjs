#!/usr/bin/env node
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const helperAppName = "Butler Menu Bar Helper.app";
const helperExecutableName = "Butler Menu Bar Helper";
const helperBundleIdentifier = "com.hexpy.butler.menubar-helper";
const appPath = resolve(process.argv[2] ?? "dist/Butler-darwin-arm64/Butler.app");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const electronRoot = resolve(scriptDir, "..");
const helperSourcePath = resolve(electronRoot, "native", "menu-bar-helper.swift");
const iconPath = resolve(electronRoot, "assets", "butler.icns");
const menuBarIconPath = resolve(electronRoot, "assets", "butler-mark-flat.png");
const helperBundlePath = resolve(
  appPath,
  "Contents",
  "Library",
  "LoginItems",
  helperAppName,
);
const helperContentsPath = resolve(helperBundlePath, "Contents");
const helperMacOsPath = resolve(helperContentsPath, "MacOS");
const helperResourcesPath = resolve(helperContentsPath, "Resources");
const helperExecutablePath = resolve(helperMacOsPath, helperExecutableName);
const helperPlistPath = resolve(helperContentsPath, "Info.plist");
const helperIconPath = resolve(helperResourcesPath, "butler.icns");
const helperMenuBarIconPath = resolve(helperResourcesPath, "butler-mark-flat.png");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return result.stdout.trim();
}

function readMainBundleVersion() {
  const plistPath = resolve(appPath, "Contents", "Info.plist");
  const result = spawnSync("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    plistPath,
  ], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) return "0.0.0";
  return result.stdout.trim() || "0.0.0";
}

function swiftCompiler() {
  return process.env.BUTLER_APP_SWIFTC?.trim() || "swiftc";
}

function helperInfoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Butler Menu Bar Helper</string>
  <key>CFBundleExecutable</key>
  <string>${helperExecutableName}</string>
  <key>CFBundleIconFile</key>
  <string>butler.icns</string>
  <key>CFBundleIdentifier</key>
  <string>${helperBundleIdentifier}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Butler Menu Bar Helper</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

if (process.platform !== "darwin") {
  process.stdout.write("macOS menu bar helper build skipped on non-darwin host\n");
  process.exit(0);
}

if (!existsSync(appPath)) throw new Error(`app bundle not found: ${appPath}`);
if (!existsSync(helperSourcePath)) {
  throw new Error(`menu bar helper source not found: ${helperSourcePath}`);
}
if (!existsSync(iconPath)) throw new Error(`Butler icon not found: ${iconPath}`);
if (!existsSync(menuBarIconPath)) {
  throw new Error(`Butler menu bar icon not found: ${menuBarIconPath}`);
}

rmSync(helperBundlePath, { recursive: true, force: true });
mkdirSync(helperMacOsPath, { recursive: true });
mkdirSync(helperResourcesPath, { recursive: true });
writeFileSync(helperPlistPath, helperInfoPlist(readMainBundleVersion()), "utf8");
copyFileSync(iconPath, helperIconPath);
copyFileSync(menuBarIconPath, helperMenuBarIconPath);
run(swiftCompiler(), [
  helperSourcePath,
  "-Osize",
  "-framework",
  "AppKit",
  "-o",
  helperExecutablePath,
]);
chmodSync(helperExecutablePath, 0o755);
run("touch", [helperBundlePath]);
process.stdout.write(`macOS menu bar helper built: ${helperBundlePath}\n`);
