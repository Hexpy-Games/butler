import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ELECTRON_ROOT = join("packages", "butler-app", "client", "electron");
const MAC_APP_BUNDLE_IDENTIFIER = "com.hexpy.butler";
const MAC_SIGN_SCRIPT = join(ELECTRON_ROOT, "scripts", "adhoc-sign-mac.mjs");
const MAC_SIGNING_SCRIPT = join("deploy", "macos", "sign-and-notarize.sh");
const MAC_NORMALIZE_SCRIPT = join(ELECTRON_ROOT, "scripts", "normalize-mac-bundle.mjs");
const MAC_APP_ICON_RESOURCE = join("Contents", "Resources", "butler.icns");

export function verifyMacBundleIcon(sourceIcon: string, appBundle: string): void {
  const packagedIcon = join(appBundle, MAC_APP_ICON_RESOURCE);
  if (!existsSync(packagedIcon)) {
    throw new Error(`packaged mac app icon resource is missing: ${packagedIcon}`);
  }
  const sourceHash = createHash("sha256").update(readFileSync(sourceIcon)).digest("hex");
  const packagedHash = createHash("sha256").update(readFileSync(packagedIcon)).digest("hex");
  if (sourceHash !== packagedHash) {
    throw new Error(
      `packaged mac app icon does not match Butler icon: expected ${sourceHash}, got ${packagedHash}`,
    );
  }
  const plistPath = join(appBundle, "Contents", "Info.plist");
  const iconFile = readPlistString(plistPath, "CFBundleIconFile");
  if (iconFile !== "butler.icns") {
    throw new Error(`packaged mac app icon plist is wrong: expected butler.icns, got ${iconFile || "missing"}`);
  }
  const iconName = readPlistString(plistPath, "CFBundleIconName");
  if (iconName !== "butler") {
    throw new Error(`packaged mac app icon name is wrong: expected butler, got ${iconName || "missing"}`);
  }
  const bundleId = readPlistString(plistPath, "CFBundleIdentifier");
  if (bundleId !== MAC_APP_BUNDLE_IDENTIFIER) {
    throw new Error(`packaged mac app bundle id is wrong: expected ${MAC_APP_BUNDLE_IDENTIFIER}, got ${bundleId || "missing"}`);
  }
}

function readPlistString(plistPath: string, key: string): string | null {
  const result = spawnSync("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${key}`,
    plistPath,
  ], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export function normalizeMacBundle(root: string, appBundle: string): void {
  const result = spawnSync("node", [join(root, MAC_NORMALIZE_SCRIPT), appBundle], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `mac bundle metadata normalization failed: ${
        result.stderr.trim() || result.stdout.trim() || "unknown error"
      }`,
    );
  }
}

export function signMacBundle(root: string, appBundle: string): void {
  if (process.env.BUTLER_SIGN_IDENTITY?.trim()) {
    runMacSigning(root, "sign-app", appBundle);
    return;
  }
  if (process.env.BUTLER_APP_REQUIRE_PRODUCTION_SIGNING === "1") {
    throw new Error("BUTLER_SIGN_IDENTITY is required for production macOS releases");
  }
  const result = spawnSync("node", [join(root, MAC_SIGN_SCRIPT), appBundle], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `mac ad-hoc signing failed: ${
        result.stderr.trim() || result.stdout.trim() || "unknown error"
      }`,
    );
  }
}

/** Developer ID signing, notarization and stapling; a logged no-op without BUTLER_SIGN_IDENTITY. */
export function runMacSigning(root: string, command: "sign-app" | "sign-dmg" | "notarize", path: string): void {
  const result = spawnSync(join(root, MAC_SIGNING_SCRIPT), [command, path], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.stdout.trim()) process.stdout.write(result.stdout);
  if (result.status !== 0) {
    throw new Error(`mac ${command} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
  }
}

