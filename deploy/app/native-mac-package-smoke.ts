import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { processRoleFileNames } from "../../packages/butler-app/client/electron/scripts/process-role-names.mjs";

export function verifyMacPackageMetadata(app: string, exactVersion: string, hardLinks: boolean): void {
  verifyMacFrameworkLinks(app);
  const resources = join(app, "Contents/Resources");
  // Use packager's own ASAR dependency, without relying on transitive hoisting.
  const electronRequire = createRequire(new URL("../../packages/butler-app/client/electron/package.json", import.meta.url));
  const packagerRequire = createRequire(electronRequire.resolve("@electron/packager"));
  const archive = join(resources, "app.asar");
  const asar = packagerRequire("@electron/asar");
  // Updates replace this path; cached ASAR offsets describe the previous bundle.
  asar.uncache(archive);
  const content = existsSync(archive)
    ? asar.extractFile(archive, "package.json").toString("utf8")
    : readFileSync(join(resources, "app/package.json"), "utf8");
  const runtime = JSON.parse(content);
  if (runtime.version !== exactVersion) throw new Error("Packaged App lost its exact release version");
  for (const path of walk(app).filter((path) => path.endsWith(".app/Contents/Info.plist"))) {
    for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
      const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path], { encoding: "utf8" });
      if (result.status !== 0 || result.stdout.trim() !== exactVersion.split(/[+-]/u)[0]) {
        throw new Error(`Invalid numeric App bundle version: ${path} ${key}`);
      }
    }
  }
  const payload = join(resources, "bundled-agent");
  for (const path of [payload, ...walk(payload)]) {
    if (statSync(path).mode & 0o222) throw new Error(`Writable native payload: ${path}`);
  }
  const binary = join(payload, "bin/butler-agent");
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const expectedHash = hash(binary);
  for (const role of processRoleFileNames("darwin")) {
    const alias = join(payload, "bin", role);
    const mode = statSync(alias);
    if (!(mode.mode & 0o111) || hash(alias) !== expectedHash ||
        (hardLinks && (mode.dev !== statSync(binary).dev || mode.ino !== statSync(binary).ino))) {
      throw new Error(`Invalid packaged process role: ${role}`);
    }
  }
}

/** Framework links must stay relative and resolve inside the relocated App. */
export function verifyMacFrameworkLinks(app: string): { frameworkLinks: number; icuBytes: number } {
  const frameworks = join(app, "Contents/Frameworks");
  let frameworkLinks = 0;
  for (const name of readdirSync(frameworks).filter(name => name.endsWith(".framework"))) {
    const framework = join(frameworks, name);
    const binary = name.slice(0, -".framework".length);
    const links = ["Versions/Current", "Resources", binary];
    if (binary === "Electron Framework") links.push("Helpers", "Libraries");
    for (const link of links) {
      const path = join(framework, link);
      const target = link === "Versions/Current" ? "A" : `Versions/Current/${link}`;
      if (!lstatSync(path).isSymbolicLink() || readlinkSync(path) !== target ||
          realpathSync(path) !== realpathSync(join(framework, "Versions/A", link === "Versions/Current" ? "" : link))) {
        throw new Error(`Invalid relocated framework link: ${path}`);
      }
      frameworkLinks++;
    }
  }
  const icu = join(frameworks, "Electron Framework.framework/Resources/icudtl.dat");
  const metadata = statSync(icu);
  if (!metadata.isFile() || metadata.size === 0) throw new Error("Electron ICU data is missing");
  return { frameworkLinks, icuBytes: metadata.size };
}

function walk(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? [path, ...walk(path)] : [path];
  });
}
