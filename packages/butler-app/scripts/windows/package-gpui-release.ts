/** Native unsigned gpui Squirrel release, consuming a release shell and Agent. */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { windowsPackageVersion } from "./windows-package-version.mjs";
import { writeWindowsReleaseOutputs } from "./release-outputs.ts";

if (process.platform !== "win32") throw new Error("Windows release packaging requires Windows");
const root = process.cwd();
const version = process.env.GITHUB_REF_NAME?.replace(/^v/u, "");
if (!version) throw new Error("GITHUB_REF_NAME is required");
windowsPackageVersion(version);
const shell = requiredPath("BUTLER_SHELL_EXECUTABLE");
const cef = requiredPath("BUTLER_CEF_RUNTIME");
requiredPath("BUTLER_NATIVE_AGENT_EXECUTABLE");
requiredPath("BUTLER_NATIVE_UI_DIST");
for (const name of ["butler_cef_host.exe", "libcef.dll", "CREDITS.html"]) {
  if (!existsSync(join(cef, name))) throw new Error(`CEF runtime is missing ${name}`);
}
const out = resolve(process.argv[2] ?? "dist/release/app-windows-gpui");
const baseUrl = process.env.BUTLER_RELEASE_BASE_URL ??
  `https://github.com/${process.env.GITHUB_REPOSITORY ?? "Hexpy-Games/butler"}/releases/download/v${version}`;
const work = mkdtempSync(join(tmpdir(), "butler-gpui-squirrel-package-"));
try {
  mkdirSync(out, { recursive: true });
  const payload = join(work, "bundled-agent");
  run("node", [join(root, "packages/butler-app/scripts/release/prepare-native-agent.mjs"), "win32", "x64", payload]);
  const built = spawnSync(join(payload, "bin/butler-agent.exe"), ["--version"], { encoding: "utf8", env: process.env });
  if (built.status !== 0 || !built.stdout.startsWith(`butler ${version} (`)) {
    throw new Error("Bundled Agent does not match the exact App version");
  }
  const app = join(work, "Butler-win32-x64");
  cpSync(cef, app, { recursive: true });
  cpSync(shell, join(app, "Butler.exe"));
  cpSync(join(root, "LICENSE"), join(app, "LICENSE"));
  cpSync(payload, join(app, "resources/bundled-agent"), { recursive: true });
  run("node", [join(root, "packages/butler-app/scripts/release/prepare-process-links.mjs"), join(app, "resources/bundled-agent/bin/butler-agent.exe")]);
  run("node", [join(root, "deploy/licenses/package-app.mjs"), app]);
  const notices = join(work, "shell-notices");
  run("python3", [join(root, "deploy/licenses/cargo-notices.py"), "--root", join(root, "packages/butler-shell"),
    "--target", "x86_64-pc-windows-msvc", "--output", notices]);
  cpSync(notices, join(app, "resources/licenses/butler-shell"), { recursive: true });
  await stampExecutable(join(app, "Butler.exe"), version);
  run("node", [join(root, "packages/butler-app/scripts/windows/create-windows-installer.mjs"),
    "--no-package-json", ...additionalAppFiles(app).flatMap(name => ["--additional-file", name]),
    "--app-directory", app, "--output-directory", out,
    "--setup-exe", `ButlerSetup-${version}-x64.exe`, "--setup-icon", join(root, "packages/butler-app/scripts/release/assets/butler.ico"), "--version", version]);
  run("node", [join(root, "packages/butler-app/scripts/windows/create-windows-portable.mjs"), app]);
  cpSync(join(work, "Butler-win32-x64-portable.zip"), join(out, `butler-app-${version}-windows-x64-portable.zip`));
  const files = writeWindowsReleaseOutputs(out, version, baseUrl);
  console.log(JSON.stringify({ version, artifacts: files, unsigned: true }));
} finally {
  rmSync(work, { recursive: true, force: true });
}

function additionalAppFiles(appDirectory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(appDirectory, { withFileTypes: true })) {
    const name = entry.name.toLowerCase();
    if (entry.isDirectory()) {
      if (!["locales", "resources", "swiftshader"].includes(name)) {
        throw new Error(`Squirrel cannot pack top-level App directory: ${entry.name}`);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (/\.(?:bin|dll|pak|exe\.config|exe\.sig)$/u.test(name)) continue;
    if (["icudtl.dat", "squirrel.exe", "license", "butler.exe", "vk_swiftshader_icd.json"].includes(name)) continue;
    files.push(entry.name);
  }
  return files;
}

function requiredPath(name: string): string {
  const value = process.env[name];
  if (!value || !isAbsolute(value) || !existsSync(value)) throw new Error(`${name} requires an existing absolute path`);
  return value;
}

async function stampExecutable(path: string, exactVersion: string) {
  const require = createRequire(import.meta.url);
  const { Data, NtExecutable, NtExecutableResource, Resource } = await import(pathToFileURL(require.resolve("resedit")).href);
  const exe = NtExecutable.from(readFileSync(path));
  const res = NtExecutableResource.from(exe);
  const icon = Data.IconFile.from(readFileSync(join(root, "packages/butler-app/scripts/release/assets/butler.ico")));
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icon.icons.map((item: any) => item.data));
  const [major, minor, patch] = exactVersion.split("-")[0]!.split(".").map(Number);
  const info = Resource.VersionInfo.create({ lang: 1033, fixedInfo: { fileOS: 0x40004, fileType: 1 }, strings: [] });
  info.setFileVersion(major, minor, patch, 0);
  info.setProductVersion(major, minor, patch, 0);
  info.setStringValues({ lang: 1033, codepage: 1200 }, {
    CompanyName: "Hexpy Games", FileDescription: "Butler", ProductName: "Butler", InternalName: "Butler",
    OriginalFilename: "Butler.exe", FileVersion: exactVersion, ProductVersion: exactVersion, SquirrelAwareVersion: "1",
  });
  info.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  writeFileSync(path, Buffer.from(exe.generate()));
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
