import {
  existsSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  FixtureCatalog,
  FixtureCatalogEntry,
  LiveScenario,
} from "../contracts.ts";
import { sha256 } from "../manifest/load-live-manifest.ts";
import { ensureRepoLocalFixtureCatalog } from "./generate-fixture-catalog.ts";
import { hashDirectory } from "./fixture-digest.ts";

export type LoadedFixtureCatalog = {
  path: string;
  sha256: string;
  entries: Map<string, FixtureCatalogEntry & { resolvedPath: string }>;
};

export function loadFixtureCatalog(scenarios: LiveScenario[]): LoadedFixtureCatalog {
  const path = process.env.BTCC_LIVE_FIXTURE_CATALOG?.trim() ||
    ensureRepoLocalFixtureCatalog(scenarios);
  const bytes = readFileSync(path);
  const catalog = JSON.parse(bytes.toString("utf8")) as FixtureCatalog;
  if (catalog.schema !== "butler.btcc.live-diagnostic-fixture-catalog.v1") {
    throw new Error(`Unexpected fixture catalog schema: ${catalog.schema}`);
  }
  const entries = new Map<string, FixtureCatalogEntry & { resolvedPath: string }>();
  for (const entry of catalog.entries) {
    if (entries.has(entry.ref)) throw new Error(`Duplicate fixture catalog ref: ${entry.ref}`);
    const resolvedPath = resolve(dirname(path), entry.path);
    if (!existsSync(resolvedPath)) throw new Error(`Fixture path does not exist: ${entry.ref}`);
    const actual = entry.kind === "directory"
      ? hashDirectory(resolvedPath)
      : sha256(readFileSync(resolvedPath));
    if (actual !== entry.sha256) throw new Error(`Fixture hash mismatch: ${entry.ref}`);
    entries.set(entry.ref, { ...entry, resolvedPath });
  }
  const missing = requiredFixtureRefs(scenarios).filter((ref) => !entries.has(ref));
  if (missing.length > 0) {
    throw new Error(`Fixture catalog is incomplete: ${missing.join(", ")}`);
  }
  return { path, sha256: sha256(bytes), entries };
}

export function requiredFixtureRefs(scenarios: LiveScenario[]): string[] {
  const refs = new Set<string>();
  for (const scenario of scenarios) {
    for (const step of scenario.setupSteps) {
      for (const [key, value] of Object.entries(step)) {
        if (key.endsWith("Ref") && typeof value === "string" && !value.startsWith("fixture-head:")) {
          refs.add(value);
        }
      }
    }
  }
  return [...refs].sort();
}
