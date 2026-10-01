import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { root, productionPackages, verifyProductionInventory } from "./generate.mjs";

// Check only packages that enter the renderer, rather than walking installed
// peers/build tools whose layout and optional binaries vary between hosts.
export function verifyRendererModules(modules, catalog) {
  const locked = new Set(productionPackages().map(({ identity }) => identity));
  const inventoried = new Set(catalog.components.map(({ id }) => id));
  const seen = new Set();
  for (const id of modules) {
    if (id.startsWith("\0") || !id.includes("/node_modules/")) continue;
    let directory = dirname(id.split("?")[0]);
    let manifest;
    while (!manifest) {
      const file = join(directory, "package.json");
      if (existsSync(file)) {
        const candidate = JSON.parse(readFileSync(file, "utf8"));
        // CJS/ESM subdirectories can contain only a `type` declaration.
        if (candidate.name && candidate.version) manifest = candidate;
      }
      if (manifest) break;
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`Cannot inventory renderer module: ${id}`);
      directory = parent;
    }
    if (seen.has(directory)) continue;
    seen.add(directory);
    const identity = `${manifest.name}@${manifest.version}`;
    if (!locked.has(identity) || !inventoried.has(`npm:${identity}`)) {
      throw new Error(`Shipped renderer dependency is not inventoried: ${identity}`);
    }
  }
  return seen.size;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catalog = JSON.parse(readFileSync(join(root, "deploy/licenses/catalog.json"), "utf8"));
  const count = verifyProductionInventory(catalog);
  if (process.argv.includes("--modules")) {
    verifyRendererModules(JSON.parse(readFileSync(0, "utf8")), catalog);
  }
  console.log(`Locked renderer license inventory verified: ${count} packages`);
}
