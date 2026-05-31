// resolveProjectKey: canonicalize a raw project hint to a registry project key.
//
// Strategy:
//   1. Exact match against registered project names.
//   2. Resolve against registered project paths (with ~ expansion).
//   3. Forward-encode each registered path using Butler's path-key encoding
//      rule and compare to the raw input.
//   4. Unknown → null. Callers must drop rather than write a drift value.
//
// No fuzzy matching and no per-user alias tables. If a new install path
// needs to resolve, register it under `projects[]` in butler.config.json.

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface RegistryProject {
  name: string;
  path: string;
}

export interface ResolveOptions {
  registry?: RegistryProject[];
  home?: string;
}

function expandHome(p: string, home: string): string {
  if (p.startsWith("~")) return join(home, p.slice(1));
  return p;
}

// Butler path keys replace every non-alphanumeric character with a dash.
export function encodeProjectPathKey(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

function readRegistry(home: string): RegistryProject[] {
  const configPath = join(home, "data", "butler.config.json");
  if (!existsSync(configPath)) return [];
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const projects = Array.isArray(config.projects)
      ? config.projects
      : Object.values(config.projects ?? {});
    return (projects as any[])
      .filter((p) => p && typeof p.name === "string" && typeof p.path === "string")
      .map((p) => ({ name: p.name, path: p.path }));
  } catch {
    return [];
  }
}

// Core resolver. Accepts either:
//   - a registered name (e.g. "butler", "daangn-tracker")
//   - an absolute filesystem path (matched against registry paths)
//   - a Butler path key (matched against forward-encoded registry paths)
//
// Returns the canonical registry name, or null if the input is not recognized.
export function resolveProjectKey(
  input: string | null | undefined,
  opts: ResolveOptions = {},
): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;

  const home = opts.home ?? homedir();
  const registry = opts.registry ?? readRegistry(process.env.BUTLER_HOME || join(home, ".butler"));

  // 1. Exact name hit.
  for (const p of registry) {
    if (p.name === raw) return p.name;
  }

  // 2. Path hit (absolute path, registry may use ~-prefixed paths).
  if (raw.startsWith("/")) {
    for (const p of registry) {
      const expanded = expandHome(p.path, home);
      if (expanded === raw) return p.name;
    }
  }

  // 3. Forward-encoded path hit.
  for (const p of registry) {
    const expanded = expandHome(p.path, home);
    if (encodeProjectPathKey(expanded) === raw) return p.name;
  }

  // 4. Unknown.
  return null;
}

// CLI: bun run resolve-project.ts <path-or-name>
// Prints the canonical project name on stdout, or exits 1 on unknown input.
if (import.meta.main) {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: resolve-project.ts <path-or-name>");
    process.exit(2);
  }
  const resolved = resolveProjectKey(arg);
  if (!resolved) {
    process.exit(1);
  }
  process.stdout.write(resolved);
}
