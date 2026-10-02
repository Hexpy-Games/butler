/** Native unsigned Squirrel release, consuming a previously built Agent. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stageElectronPackageSource } from "../release/electron-package-source.ts";

if (process.platform !== "win32") throw new Error("Windows release packaging requires Windows");
const root = process.cwd();
const electron = join(root, "packages/butler-app/client/electron");
const version = process.env.GITHUB_REF_NAME?.replace(/^v/u, "");
if (!version) throw new Error("GITHUB_REF_NAME is required");
const out = resolve(process.argv[2] ?? "dist/release/app-windows");
const work = mkdtempSync(join(tmpdir(), "butler-squirrel-package-"));
const baseUrl = process.env.BUTLER_RELEASE_BASE_URL ??
  `https://github.com/${process.env.GITHUB_REPOSITORY ?? "Hexpy-Games/butler"}/releases/download/v${version}`;
try {
  mkdirSync(out, { recursive: true });
  const payload = join(work, "bundled-agent");
  run("node", [join(electron, "scripts/prepare-native-agent.mjs"), "win32", "x64", payload]);
  const source = stageElectronPackageSource(root, join(work, "source"));
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const renderer = join(work, "app-client");
  cpSync(process.env.BUTLER_NATIVE_UI_DIST ?? join(root, "packages/butler-app/client/ui/dist"), renderer, { recursive: true });
  run("node", [join(electron, "node_modules/@electron/packager/bin/electron-packager.mjs"), source, "Butler",
    "--platform=win32", "--arch=x64", `--electron-version=${pkg.devDependencies.electron}`,
    `--out=${work}`, `--icon=${join(electron, "assets/butler.ico")}`,
    `--extra-resource=${payload}`, `--extra-resource=${renderer}`, "--overwrite", "--quiet"]);
  const app = join(work, "Butler-win32-x64");
  run("node", [join(electron, "scripts/prepare-process-links.mjs"), join(app, "resources/bundled-agent/bin/butler-agent.exe")]);
  run("node", [join(root, "deploy/licenses/package-app.mjs"), app]);
  run("node", [join(electron, "scripts/create-windows-installer.mjs"),
    "--app-directory", app, "--output-directory", out,
    "--setup-exe", `ButlerSetup-${version}-x64.exe`, "--setup-icon", join(electron, "assets/butler.ico"), "--version", version]);
  run("node", [join(electron, "scripts/create-windows-portable.mjs"), app]);
  cpSync(join(work, "Butler-win32-x64-portable.zip"), join(out, `butler-app-${version}-windows-x64-portable.zip`));
  const files = readdirSync(out).filter(name => name === "RELEASES" || /\.(exe|nupkg|zip)$/u.test(name));
  const digests = new Map<string, string>();
  for (const name of files) {
    const digest = createHash("sha256").update(readFileSync(join(out, name))).digest("hex");
    digests.set(name, digest);
    writeFileSync(join(out, `${name}.sha256`), `${digest}  ${name}\n`);
  }
  const packages = files.filter(name => name.endsWith("-full.nupkg"));
  if (packages.length !== 1) throw new Error("Expected one selected full nupkg");
  const name = packages[0]!;
  writeFileSync(join(out, "app-update-manifest.json"), JSON.stringify({
    app_version: version, bundled_agent_version: version, artifacts: [{
      component: "app", product: "butler-app", platform: "windows-x64", version,
      app_version: version, bundled_agent_version: version, channel: version.includes("-") ? "preview" : "stable",
      artifact_url: `${baseUrl}/${name}`, sha256: digests.get(name), package_format: "nupkg",
      payload_format: "platform-app-package", update_policy: "app-user-action", restart_policy: "restart-app",
      updater_owner: "butler-app", staging_policy: "butler-data-updates",
      activation_policy: "user-installs-app-package", rollback_policy: "not-managed-by-butler",
    }],
  }, null, 2) + "\n");
  console.log(JSON.stringify({ version, artifacts: files, unsigned: true }));
} finally {
  rmSync(work, { recursive: true, force: true });
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
