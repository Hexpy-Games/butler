/** Pack an unsigned Microsoft Store package without modifying the App folder. */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { storePackageVersion } from "./store-version.ts";
import { processRoleFileNames } from "../../../client/electron/scripts/process-role-names.mjs";

const usage = "bun run packages/butler-app/scripts/windows/store/pack-msix.ts --app <folder> --out <file.msix> --app-version <M.m.p[-preview.N]>";
const flags = ["--app", "--out", "--app-version"];
const args = process.argv.slice(2);
const values = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i]!;
  const value = args[i + 1];
  if (!flags.includes(flag) || !value || value.startsWith("--")) throw new Error(usage);
  values.set(flag, value);
}
if (flags.some(flag => !values.has(flag))) throw new Error(usage);
const app = resolve(values.get("--app")!);
const out = resolve(values.get("--out")!);
const { name: identityName, publisher, publisherDisplayName } = JSON.parse(
  readFileSync(join(import.meta.dir, "identity.json"), "utf8"),
) as { name: string; publisher: string; publisherDisplayName: string };
const appVersion = values.get("--app-version")!;
const version = storePackageVersion(appVersion);
if (!existsSync(join(app, "Butler.exe"))) throw new Error("App folder must contain Butler.exe");
if (!publisher.startsWith("CN=")) throw new Error("Publisher must start with CN=");
if (!/^[A-Za-z0-9.-]{3,50}$/u.test(identityName)) throw new Error("Invalid identity name");
const bin = join(app, "resources/bundled-agent/bin");
const roleNames = processRoleFileNames("win32");
if (readdirSync(bin).some(name => roleNames.includes(name))) {
  throw new Error("Store packages must not contain Agent process role links or copies");
}
const replacements: Record<string, string> = {
  IdentityName: identityName, Publisher: publisher, Version: version,
  PublisherDisplayName: publisherDisplayName,
};
const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const manifest = readFileSync(join(import.meta.dir, "AppxManifest.xml"), "utf8")
  .replace(/\{\{(\w+)\}\}/gu, (placeholder, key: string) =>
    replacements[key]?.replace(/[&<>"']/gu, char => escapes[char]!) ?? placeholder);
if (manifest.includes("{{")) throw new Error("Unresolved manifest placeholder");
function sdkTool(name: string): string {
  const sdk = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  const versions = existsSync(sdk) ? readdirSync(sdk).filter(version => /^10\.\d+\.\d+\.\d+$/u.test(version)) : [];
  versions.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  const tool = versions.map(version => join(sdk, version, "x64", name)).find(path => existsSync(path));
  if (!tool) throw new Error(`${name} not found in the Windows SDK`);
  return tool;
}
const work = mkdtempSync(join(tmpdir(), "butler-msix-"));
try {
  const pri = join(work, "pri");
  mkdirSync(join(pri, "Assets"), { recursive: true });
  const manifestPath = join(pri, "AppxManifest.xml");
  writeFileSync(manifestPath, manifest);
  const mapping = ["[Files]"];
  function add(source: string, destination: string) {
    mapping.push(`"${source}" "${destination.replaceAll("/", "\\")}"`);
  }
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const source = join(dir, entry.name);
      if (entry.isDirectory()) walk(source);
      else add(source, relative(app, source));
    }
  }
  walk(app);
  add(manifestPath, "AppxManifest.xml");
  const assets = join(import.meta.dir, "Assets");
  const assetNames = readdirSync(assets).filter(name => name.endsWith(".png"));
  if (assetNames.length === 0) throw new Error("Store Assets must contain PNGs");
  for (const name of assetNames) {
    const target = join(pri, "Assets", name);
    copyFileSync(join(assets, name), target);
    add(target, `Assets\\${name}`);
  }
  const makepri = sdkTool("makepri.exe");
  const config = join(work, "priconfig.xml");
  const resources = join(work, "resources.pri");
  const configured = spawnSync(makepri, ["createconfig", "/cf", config, "/dq", "lang-en-US", "/pv", "10.0.0", "/o"], { stdio: "inherit" });
  if (configured.status !== 0) throw new Error(`makepri createconfig failed (${configured.status})`);
  writeFileSync(config, readFileSync(config, "utf8").replace(/<packaging\b[^>]*>[\s\S]*?<\/packaging>/gu, ""));
  const indexed = spawnSync(makepri, ["new", "/pr", pri, "/cf", config, "/mn", manifestPath, "/of", resources, "/o"], { stdio: "inherit" });
  if (indexed.status !== 0) throw new Error(`makepri new failed (${indexed.status})`);
  add(resources, "resources.pri");
  const mappingPath = join(work, "mapping.txt");
  writeFileSync(mappingPath, mapping.join("\r\n") + "\r\n");
  const makeappx = sdkTool("makeappx.exe");
  const result = spawnSync(makeappx, ["pack", "/f", mappingPath, "/p", out, "/o"], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`makeappx failed (${result.status})`);
  console.log(JSON.stringify({ out, bytes: statSync(out).size, appVersion, version, identityName }));
} finally {
  rmSync(work, { recursive: true, force: true });
}
