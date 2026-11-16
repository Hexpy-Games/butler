/** Pack an unsigned Microsoft Store package without modifying the App folder. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { processRoleFileNames } from "../../../client/electron/scripts/process-role-names.mjs";

const usage = "bun run packages/butler-app/scripts/windows/store/pack-msix.ts --app <folder> --out <file.msix> --identity-name <Name> --publisher <CN=...> --publisher-display-name <text> --version <a.b.c.d>";
const flags = ["--app", "--out", "--identity-name", "--publisher", "--publisher-display-name", "--version"];
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
const identityName = values.get("--identity-name")!;
const publisher = values.get("--publisher")!;
const version = values.get("--version")!;
if (!existsSync(join(app, "Butler.exe"))) throw new Error("App folder must contain Butler.exe");
if (!/^\d+\.\d+\.\d+\.\d+$/u.test(version) || version.split(".").some(part => Number(part) > 65535)) {
  throw new Error("Version must have four integer parts, each at most 65535");
}
if (!publisher.startsWith("CN=")) throw new Error("Publisher must start with CN=");
if (!/^[A-Za-z0-9.-]{3,50}$/u.test(identityName)) throw new Error("Invalid identity name");
const bin = join(app, "resources/bundled-agent/bin");
const roleNames = processRoleFileNames("win32");
if (readdirSync(bin).some(name => roleNames.includes(name))) {
  throw new Error("Store packages must not contain Agent process role links or copies");
}
const replacements: Record<string, string> = {
  IdentityName: identityName, Publisher: publisher, Version: version,
  PublisherDisplayName: values.get("--publisher-display-name")!,
};
const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const manifest = readFileSync(join(import.meta.dir, "AppxManifest.xml"), "utf8")
  .replace(/\{\{(\w+)\}\}/gu, (placeholder, key: string) =>
    replacements[key]?.replace(/[&<>"']/gu, char => escapes[char]!) ?? placeholder);
if (manifest.includes("{{")) throw new Error("Unresolved manifest placeholder");
const work = mkdtempSync(join(tmpdir(), "butler-msix-"));
try {
  const manifestPath = join(work, "AppxManifest.xml");
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
  const icon = resolve(import.meta.dir, "../../../client/electron/assets/icon.png");
  for (const name of ["StoreLogo", "Square150x150Logo", "Square44x44Logo"]) add(icon, `Assets\\${name}.png`);
  const mappingPath = join(work, "mapping.txt");
  writeFileSync(mappingPath, mapping.join("\r\n") + "\r\n");
  let makeappx = process.env.MAKEAPPX;
  if (!makeappx) {
    const sdk = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
    const versions = existsSync(sdk) ? readdirSync(sdk).filter(name => /^10\.\d+\.\d+\.\d+$/u.test(name)) : [];
    versions.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
    makeappx = versions.map(name => join(sdk, name, "x64/makeappx.exe")).find(path => existsSync(path));
  }
  if (!makeappx) throw new Error("makeappx.exe not found in the Windows SDK");
  const result = spawnSync(makeappx, ["pack", "/f", mappingPath, "/p", out, "/o"], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`makeappx failed (${result.status})`);
  console.log(JSON.stringify({ out, bytes: statSync(out).size, version, identityName }));
} finally {
  rmSync(work, { recursive: true, force: true });
}
