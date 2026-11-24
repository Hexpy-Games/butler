import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Butler</string>
  <key>CFBundleDisplayName</key><string>Butler</string>
  <key>CFBundleExecutable</key><string>Butler</string>
  <key>CFBundleIdentifier</key><string>com.hexpy.butler</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>0.0.0</string>
  <key>CFBundleVersion</key><string>0.0.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSCameraUsageDescription</key><string>This app needs access to the camera</string>
  <key>NSMicrophoneUsageDescription</key><string>This app needs access to the microphone</string>
</dict>
</plist>
`;

/** Lays out the gpui shell, the CEF host and the bundled Agent as Butler.app; signing happens in the common flow. */
export function stageGpuiMacBundle(input: { root: string; packageOut: string; bundledAgentResourceDir: string }): string {
  const executable = requiredPath("BUTLER_SHELL_EXECUTABLE");
  const runtime = requiredPath("BUTLER_CEF_RUNTIME");
  const hostApp = join(runtime, "ButlerCefHost.app", "Contents");
  const hostBinary = join(hostApp, "MacOS", "butler-cef-host");
  const frameworks = join(hostApp, "Frameworks");
  const credits = join(runtime, "CREDITS.html");
  if (!statSync(hostBinary, { throwIfNoEntry: false })?.isFile()) throw new Error("CEF runtime is missing ButlerCefHost.app/Contents/MacOS/butler-cef-host");
  if (!statSync(join(frameworks, "Chromium Embedded Framework.framework"), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("CEF runtime is missing ButlerCefHost.app/Contents/Frameworks/Chromium Embedded Framework.framework");
  }
  if (!statSync(credits, { throwIfNoEntry: false })?.isFile()) throw new Error("CEF runtime is missing CREDITS.html");
  if (!statSync(join(input.bundledAgentResourceDir, "native-agent-manifest.json"), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`bundled Agent payload has no native-agent-manifest.json: ${input.bundledAgentResourceDir} (build it with prepare-native-agent.mjs)`);
  }

  const appBundle = join(input.packageOut, "Butler-darwin-arm64", "Butler.app");
  const contents = join(appBundle, "Contents");
  const macos = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  mkdirSync(macos, { recursive: true });
  mkdirSync(join(resources, "licenses", "cef"), { recursive: true });
  const plist = join(contents, "Info.plist");
  writeFileSync(plist, INFO_PLIST, "utf8");
  run("plutil", ["-lint", plist]);

  // ditto keeps modes and the framework and helper symlinks.
  run("ditto", [executable, join(macos, "Butler")]);
  run("ditto", [hostBinary, join(macos, "butler-cef-host")]);
  chmodSync(join(macos, "Butler"), 0o755);
  chmodSync(join(macos, "butler-cef-host"), 0o755);
  run("ditto", [frameworks, join(contents, "Frameworks")]);
  run("ditto", [input.bundledAgentResourceDir, join(resources, "bundled-agent")]);

  run(process.env.BUTLER_NODE || "node", [join(input.root, "deploy/licenses/package-app.mjs"), appBundle], { cwd: input.root });
  run(process.env.PYTHON3 || "python3", [
    join(input.root, "deploy/licenses/cargo-notices.py"),
    "--root", join(input.root, "packages/butler-shell"),
    "--target", "aarch64-apple-darwin",
    "--output", join(resources, "licenses", "butler-shell"),
  ], { cwd: input.root });
  run("ditto", [credits, join(resources, "licenses", "cef", "CREDITS.html")]);
  return appBundle;
}

function run(command: string, args: string[], options: { cwd?: string } = {}): void {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr.trim() || result.stdout.trim() || result.error?.message || "unknown error"}`);
  }
}

function requiredPath(name: string): string {
  const value = process.env[name];
  if (!value || !isAbsolute(value) || !existsSync(value)) throw new Error(`${name} requires an existing absolute path`);
  return value;
}
