import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { prepareBundledAgentResource } from
  "../../../packages/butler-app/scripts/release/package-app-release.ts";
import type { BenchmarkTarget } from "./contracts.ts";

const CACHE_SCHEMA = "butler.btcc-benchmark-bundled-agent-cache.v1";

type ResourcePreparer = (
  repoRoot: string,
  workDir: string,
) => { resourceDir: string };

export function prepareBenchmarkBundledAgentResource(
  input: {
    runRoot: string;
    target: BenchmarkTarget;
  },
  prepare: ResourcePreparer = prepareBundledAgentResource,
): string {
  const cacheKey = createHash("sha256")
    .update(`${input.target.commit}\0${input.target.buildId}`)
    .digest("hex")
    .slice(0, 24);
  const cacheRoot = resolve(
    input.runRoot,
    "shared-product-resources",
    `r3-${cacheKey}`,
  );
  const pointerPath = join(cacheRoot, "resource.json");
  const cached = readCachePointer(pointerPath);
  if (
    cached?.schema === CACHE_SCHEMA &&
    cached.commit === input.target.commit &&
    cached.buildId === input.target.buildId &&
    typeof cached.resourceDir === "string" &&
    usableResource(cacheRoot, cached.resourceDir)
  ) {
    return resolve(cached.resourceDir);
  }

  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const attemptRoot = join(cacheRoot, `prepare-${randomUUID()}`);
  const prepared = prepare(input.target.worktreePath, attemptRoot);
  if (!usableResource(attemptRoot, prepared.resourceDir)) {
    throw new Error("Prepared benchmark bundled Agent resource is incomplete.");
  }
  writeJsonAtomically(pointerPath, {
    schema: CACHE_SCHEMA,
    commit: input.target.commit,
    buildId: input.target.buildId,
    resourceDir: resolve(prepared.resourceDir),
  });
  return resolve(prepared.resourceDir);
}

function readCachePointer(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function usableResource(parent: string, candidate: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedCandidate = resolve(candidate);
  const diff = relative(resolvedParent, resolvedCandidate);
  if (diff === "" || diff.startsWith("..") || isAbsolute(diff)) return false;
  try {
    return statSync(resolvedCandidate).isDirectory() &&
      existsSync(join(resolvedCandidate, "agent-release-manifest.json")) &&
      existsSync(join(resolvedCandidate, "agent-update-manifest.json")) &&
      statSync(join(resolvedCandidate, "runtime")).isDirectory();
  } catch {
    return false;
  }
}

function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}
