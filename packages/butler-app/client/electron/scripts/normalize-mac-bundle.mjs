#!/usr/bin/env node
import {
  constants,
  accessSync,
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appPath = resolve(process.argv[2] ?? "dist/Butler-darwin-arm64/Butler.app");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const iconPath = resolve(scriptDir, "..", "assets", "butler.icns");
const helperBuildScript = resolve(scriptDir, "build-mac-menu-bar-helper.mjs");
const plistPath = resolve(appPath, "Contents", "Info.plist");
const targetIconPath = resolve(appPath, "Contents", "Resources", "butler.icns");
const nativeAgentRoot = resolve(appPath, "Contents", "Resources", "bundled-agent");
const nativeAgentBinary = resolve(nativeAgentRoot, "bin", "butler-agent");
const nativeAgentResources = resolve(nativeAgentRoot, "resources");

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
if (!existsSync(nativeAgentBinary) || !statSync(nativeAgentBinary).isFile()) {
  throw new Error(`native Butler Agent executable not found: ${nativeAgentBinary}`);
}
if (!existsSync(nativeAgentResources) || !statSync(nativeAgentResources).isDirectory()) {
  throw new Error(`native Butler Agent resources not found: ${nativeAgentResources}`);
}
accessSync(nativeAgentBinary, constants.X_OK);
setNativePayloadReadOnly(nativeAgentRoot);

copyFileSync(iconPath, targetIconPath);
setPlistString("CFBundleDisplayName", "Butler");
setPlistString("CFBundleName", "Butler");
setPlistString("CFBundleIdentifier", "com.hexpy.butler");
setPlistString("CFBundleIconFile", "butler.icns");
setPlistString("CFBundleIconName", "butler");
run("node", [helperBuildScript, appPath]);
run("touch", [appPath]);

process.stdout.write(`macOS bundle metadata normalized: ${appPath}\n`);

function setNativePayloadReadOnly(root) {
  const entries = walk(root);
  for (const path of entries.filter((path) => statSync(path).isFile())) {
    chmodSync(path, path === nativeAgentBinary ? 0o555 : 0o444);
  }
  for (const path of entries.filter((path) => statSync(path).isDirectory()).reverse()) {
    chmodSync(path, 0o555);
  }
  chmodSync(root, 0o555);
}

function walk(root) {
  const paths = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    paths.push(path);
    if (entry.isDirectory()) paths.push(...walk(path));
  }
  return paths;
}
