#!/usr/bin/env node
import { copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appPath = resolve(process.argv[2] ?? "dist/Butler-darwin-arm64/Butler.app");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const iconPath = resolve(scriptDir, "..", "assets", "butler.icns");
const helperBuildScript = resolve(scriptDir, "build-mac-menu-bar-helper.mjs");
const plistPath = resolve(appPath, "Contents", "Info.plist");
const targetIconPath = resolve(appPath, "Contents", "Resources", "butler.icns");

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
}

function setPlistString(key, value) {
  const plistBuddy = "/usr/libexec/PlistBuddy";
  const setResult = spawnSync(
    plistBuddy,
    ["-c", `Set :${key} ${value}`, plistPath],
    { encoding: "utf8", stdio: "pipe" },
  );
  if (!setResult.error && setResult.status === 0) return;

  const addResult = spawnSync(
    plistBuddy,
    ["-c", `Add :${key} string ${value}`, plistPath],
    { encoding: "utf8", stdio: "pipe" },
  );
  if (addResult.status !== 0) {
    const output = [setResult.stdout, setResult.stderr, addResult.stdout, addResult.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`failed to set ${key}${output ? `:\n${output}` : ""}`);
  }
}

if (process.platform !== "darwin") {
  process.stdout.write("macOS bundle normalization skipped on non-darwin host\n");
  process.exit(0);
}

if (!existsSync(appPath)) throw new Error(`app bundle not found: ${appPath}`);
if (!existsSync(plistPath)) throw new Error(`Info.plist not found: ${plistPath}`);
if (!existsSync(iconPath)) throw new Error(`Butler icon not found: ${iconPath}`);

copyFileSync(iconPath, targetIconPath);
setPlistString("CFBundleDisplayName", "Butler");
setPlistString("CFBundleName", "Butler");
setPlistString("CFBundleIdentifier", "com.hexpy.butler");
setPlistString("CFBundleIconFile", "butler.icns");
setPlistString("CFBundleIconName", "butler");
run("node", [helperBuildScript, appPath]);
run("touch", [appPath]);

process.stdout.write(`macOS bundle metadata normalized: ${appPath}\n`);
