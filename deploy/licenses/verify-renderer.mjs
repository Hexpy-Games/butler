import { createRequire } from "node:module";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { productionPackages, root, readLock } from "./generate.mjs";

// Packaging must use bun.lock, including transitive versions. npm's legacy
// workspace lockfiles can otherwise silently replace the inventoried graph.
const locked = new Set(productionPackages().map(({ identity }) => identity));
const seen = new Set();
function visit(name, directory) {
  if (name.startsWith("@types/")) return;
  const require = createRequire(join(directory, "package.json"));
  const candidate = require.resolve.paths(name)?.map((path) => join(path, name, "package.json"))
    .find((path) => existsSync(path));
  if (!candidate) throw new Error(`Cannot inventory installed package: ${name}`);
  const parent = dirname(realpathSync(candidate));
  const manifest = JSON.parse(readFileSync(join(parent, "package.json"), "utf8"));
  const identity = `${name}@${manifest.version}`;
  if (!locked.has(identity)) throw new Error(`Installed renderer differs from bun.lock: ${identity}; run bun install --frozen-lockfile --ignore-scripts`);
  if (seen.has(identity)) return;
  seen.add(identity);
  for (const child of Object.keys(manifest.dependencies ?? {})) visit(child, parent);
  for (const child of Object.keys(manifest.peerDependencies ?? {})) {
    if (!manifest.peerDependenciesMeta?.[child]?.optional) visit(child, parent);
  }
}
const workspace = "packages/butler-app/client/ui";
for (const name of Object.keys(readLock().workspaces[workspace].dependencies)) {
  if (!["vite", "typescript", "@vitejs/plugin-react"].includes(name)) visit(name, join(root, workspace));
}
console.log(`Installed renderer license inventory verified: ${seen.size} packages`);
