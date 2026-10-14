import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { preProcessFile } from "typescript";
import { readAppComponentVersions } from "./manifest.ts";
import { stageElectronRuntimeDependencies } from "./electron-runtime-dependencies.ts";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Relative module paths must stay inside the staged shell, including nested scripts. */
function checkElectronImports(root: string, directory = root): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" && entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { checkElectronImports(root, path); continue; }
    if (!entry.name.endsWith(".mjs")) continue;
    const imports = preProcessFile(readFileSync(path, "utf8"), true, true).importedFiles;
    for (const { fileName: specifier } of imports) {
      if (specifier.startsWith("node:")) continue;
      // Bare package names in build scripts are not filesystem references.
      if (!specifier.startsWith(".") && !isAbsolute(specifier) && !specifier.includes(":")) continue;
      const target = relative(root, resolve(dirname(path), specifier));
      if (!specifier.startsWith(".") || isAbsolute(target) || target === ".." || target.startsWith("../") || target.startsWith("..\\")) {
        throw new Error(`Electron import outside package: ${relative(root, path)} -> ${specifier}`);
      }
    }
  }
}

/** Stage the Electron shell without development-only package-manager trees. */
export function stageElectronPackageSource(root: string, destination: string): string {
  const source = join(root, "packages/butler-app/client/electron");
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const excluded = new Set(["node_modules", "dist", ".native-agent-payload"]);
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, {
    recursive: true,
    filter: (path) => !excluded.has(relative(source, path).split(/[\\/]/u)[0]),
  });
  stageElectronRuntimeDependencies(root, source, destination);
  checkElectronImports(destination);
  manifest.version = readAppComponentVersions(root).app;
  // The staged tree holds only the production closure, so the staged manifest must not name dev tooling:
  // electron-packager's prune walk resolves every listed devDependency from the staged node_modules.
  delete manifest.devDependencies;
  writeFileSync(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return destination;
}
