import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readAppComponentVersions } from "./manifest.ts";
import { join, relative } from "node:path";

/** Stage the Electron shell without development-only package-manager trees. */
export function stageElectronPackageSource(root: string, destination: string): string {
  const source = join(root, "packages/butler-app/client/electron");
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  // The shell uses Electron/Node built-ins. Renderer dependencies are bundled
  // separately. Refuse to omit modules if this runtime contract ever changes.
  if (Object.keys(manifest.dependencies ?? {}).length || Object.keys(manifest.optionalDependencies ?? {}).length) {
    throw new Error("Electron runtime dependencies require an inventoried packaging layout");
  }
  const excluded = new Set(["node_modules", "dist", ".native-agent-payload"]);
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, {
    recursive: true,
    filter: (path) => !excluded.has(relative(source, path).split(/[\\/]/u)[0]),
  });
  manifest.version = readAppComponentVersions(root).app;
  writeFileSync(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return destination;
}
