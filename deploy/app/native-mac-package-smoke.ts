import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { processRoleFileNames } from "../../packages/butler-app/client/electron/scripts/process-role-names.mjs";

export function verifyMacPackageMetadata(app: string, exactVersion: string, hardLinks: boolean): void {
  const resources = join(app, "Contents/Resources");
  // Use packager's own ASAR dependency, without relying on transitive hoisting.
  const electronRequire = createRequire(new URL("../../packages/butler-app/client/electron/package.json", import.meta.url));
  const packagerRequire = createRequire(electronRequire.resolve("@electron/packager"));
  const archive = join(resources, "app.asar");
  const content = existsSync(archive)
    ? packagerRequire("@electron/asar").extractFile(archive, "package.json").toString("utf8")
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
        (hardLinks && mode.ino !== statSync(binary).ino)) {
      throw new Error(`Invalid packaged process role: ${role}`);
    }
  }
}

function walk(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? [path, ...walk(path)] : [path];
  });
}
