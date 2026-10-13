import { cpSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

function resolvePackage(source: string, name: string): string {
  const require = createRequire(join(source, "package.json"));
  let directory = dirname(realpathSync(require.resolve(name)));
  while (true) {
    const file = join(directory, "package.json");
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).name === name) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Missing runtime package: ${name}`);
    directory = parent;
  }
}

/** Copy the installed, inventoried production closure; no package-manager links escape the staged App. */
function copyPackage(source: string, name: string, destination: string, inventory: Set<string>, ancestors: Map<string, string>): void {
  const directory = resolvePackage(source, name);
  if (ancestors.get(name) === directory) return;
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (!inventory.has(`npm:${manifest.name}@${manifest.version}`)) throw new Error(`Uninventoried Electron runtime package: ${name}`);
  const target = join(destination, "node_modules", name);
  cpSync(directory, target, { recursive: true, dereference: true,
    filter: path => relative(directory, path).split(/[\\/]/u)[0] !== "node_modules" });
  const parents = new Map(ancestors).set(name, directory);
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    copyPackage(directory, dependency, target, inventory, parents);
  }
}

export function stageElectronRuntimeDependencies(root: string, source: string, destination: string): void {
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies });
  if (!dependencies.length) return;
  const catalog = join(root, "deploy/licenses/catalog.json");
  if (!existsSync(catalog)) throw new Error("Electron runtime dependencies require an inventoried packaging layout");
  const components = JSON.parse(readFileSync(catalog, "utf8")).components as { id: string }[];
  const inventory = new Set(components.map(component => component.id));
  for (const name of dependencies) copyPackage(source, name, destination, inventory, new Map());
}
