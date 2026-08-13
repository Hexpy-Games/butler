import { lstat, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { projectLedgerProtectedPath } from "./project-ledger-protection.ts";
import { looksSensitiveWorkspacePath } from "./workspace-path-guard.ts";

export const DEFAULT_EXCLUDED_DIRS = new Set([
  ".cache",
  ".git",
  ".next",
  ".project-ledger",
  ".tmp",
  ".turbo",
  "build",
  "coverage",
  "dist",
  ".generated",
  "generated",
  "node_modules",
  "project-ledger",
  "vendor",
]);

export type TraversalStoppedBy = "max_results" | "max_files" | "max_dirs" | "max_depth" | "elapsed_ms" | "io_error";

export interface WorkspaceTraversalEntry {
  path: string;
  absolutePath: string;
  bytes: number;
}

export interface WorkspaceTraversalLimits {
  maxResults: number;
  maxFiles: number;
  maxDirs: number;
  maxDepth: number;
  elapsedMs: number;
}

export interface WorkspaceTraversalResult {
  entries: WorkspaceTraversalEntry[];
  filesConsidered: number;
  dirsVisited: number;
  truncated: boolean;
  stoppedBy?: TraversalStoppedBy;
  elapsedMs: number;
  ioErrors: number;
  /** Last path that was fully considered; used to advance bounded cursors. */
  lastFilePath?: string;
  /** Last directory/file path reached, including when no file matched filters. */
  lastPath?: string;
}

export interface WorkspaceTraversalOptions {
  workspaceRoot: string;
  rootPath: string;
  includeGlobs?: readonly string[];
  excludeGlobs?: readonly string[];
  afterPath?: string;
  includeAfterPath?: boolean;
  /** Runtime Project Ledger roots are pruned before any metadata/read work. */
  protectedProjectLedgerRoots?: readonly string[];
  limits?: Partial<WorkspaceTraversalLimits>;
}

/** Only file/result caps establish a safe exclusive path boundary. Directory,
 * depth, elapsed, and I/O stops can leave an unvisited subtree before the
 * marker, so callers must retry with narrower bounds instead of issuing a
 * potentially repeating cursor. */
export function traversalSupportsCursor(stoppedBy?: TraversalStoppedBy): boolean {
  return stoppedBy === undefined || stoppedBy === "max_results" || stoppedBy === "max_files";
}

const DEFAULT_LIMITS: WorkspaceTraversalLimits = {
  maxResults: 100,
  maxFiles: 5_000,
  maxDirs: 1_000,
  maxDepth: 25,
  elapsedMs: 5_000,
};

export function compareWorkspacePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const compareStrings = compareWorkspacePaths;

function normalizeGlob(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//u, "");
}

function createGlobMatcher(glob: string): (path: string) => boolean {
  const normalized = normalizeGlob(glob);
  if (!normalized) return () => false;
  const matcher = new Bun.Glob(normalized);
  const matchesBasename = !normalized.includes("/");
  return (path) => matcher.match(path) || (matchesBasename && matcher.match(basename(path)));
}

function matchesAny(matchers: readonly ((path: string) => boolean)[], path: string): boolean {
  return matchers.some((matcher) => matcher(path));
}

function canPruneExcludedDirectory(path: string, excludeGlobs: readonly string[], matchers: readonly ((path: string) => boolean)[]): boolean {
  if (matchesAny(matchers, path)) return true;
  const normalized = path.endsWith("/") ? path : `${path}/`;
  return excludeGlobs.some((glob) => {
    const value = normalizeGlob(glob).replace(/\/\*\*?(?:\/|$).*$/u, "");
    return value.length > 0 && (normalized === `${value}/` || normalized.startsWith(`${value}/`));
  });
}

function limitsFor(input?: Partial<WorkspaceTraversalLimits>): WorkspaceTraversalLimits {
  const source = input ?? {};
  const bounded = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(Math.floor(parsed), max)) : fallback;
  };
  return {
    maxResults: bounded(source.maxResults ?? DEFAULT_LIMITS.maxResults, DEFAULT_LIMITS.maxResults, 1, 10_000),
    maxFiles: bounded(source.maxFiles ?? DEFAULT_LIMITS.maxFiles, DEFAULT_LIMITS.maxFiles, 1, 50_000),
    maxDirs: bounded(source.maxDirs ?? DEFAULT_LIMITS.maxDirs, DEFAULT_LIMITS.maxDirs, 1, 10_000),
    maxDepth: bounded(source.maxDepth ?? DEFAULT_LIMITS.maxDepth, DEFAULT_LIMITS.maxDepth, 0, 100),
    elapsedMs: bounded(source.elapsedMs ?? DEFAULT_LIMITS.elapsedMs, DEFAULT_LIMITS.elapsedMs, 10, 30_000),
  };
}

/**
 * One bounded, deterministic owner for list_files and grep_files discovery.
 * Filters are checked while walking; callers never receive an unbounded file list.
 */
export async function traverseWorkspaceFiles(input: WorkspaceTraversalOptions): Promise<WorkspaceTraversalResult> {
  const startedAt = Date.now();
  const limits = limitsFor(input.limits);
  const includeGlobs = (input.includeGlobs ?? []).map(normalizeGlob).filter(Boolean);
  const excludeGlobs = (input.excludeGlobs ?? []).map(normalizeGlob).filter(Boolean);
  const includeMatchers = includeGlobs.map(createGlobMatcher);
  const excludeMatchers = excludeGlobs.map(createGlobMatcher);
  const protectedRoots = (input.protectedProjectLedgerRoots ?? [])
    .filter((root): root is string => typeof root === "string" && root.trim().length > 0)
    .map((root) => isAbsolute(root) ? root : resolve(input.workspaceRoot, root));
  const isProtectedPath = (absolutePath: string): boolean => projectLedgerProtectedPath({
    workspaceRoot: input.workspaceRoot,
    absolutePath,
    explicitProjectLedgerRoots: protectedRoots,
  }).protected;
  const entries: WorkspaceTraversalEntry[] = [];
  let filesConsidered = 0;
  let dirsVisited = 0;
  let truncated = false;
  let stoppedBy: TraversalStoppedBy | undefined;
  let ioErrors = 0;
  let lastFilePath: string | undefined;
  let lastPath: string | undefined;

  const stop = (reason: TraversalStoppedBy) => {
    if (!truncated) {
      truncated = true;
      stoppedBy = reason;
    }
  };

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return;
    if (Date.now() - startedAt >= limits.elapsedMs) return stop("elapsed_ms");
    if (depth > limits.maxDepth) return stop("max_depth");
    try {
      const directoryStat = await lstat(dir);
      if (!directoryStat.isDirectory()) return;
    } catch {
      ioErrors += 1;
      return stop("io_error");
    }
    dirsVisited += 1;
    if (dirsVisited > limits.maxDirs) return stop("max_dirs");
    let directoryEntries;
    try {
      directoryEntries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => compareStrings(a.name, b.name));
    } catch {
      ioErrors += 1;
      return stop("io_error");
    }
    for (const entry of directoryEntries) {
      if (truncated) return;
      if (Date.now() - startedAt >= limits.elapsedMs) return stop("elapsed_ms");
      const absolutePath = join(dir, entry.name);
      const path = relative(input.workspaceRoot, absolutePath).replace(/\\/g, "/");
      if (!path || looksSensitiveWorkspacePath(path)) continue;
      // The shared traversal owner, rather than each executor, prunes explicit
      // Project Ledger roots before descent or file metadata can be exposed.
      if (isProtectedPath(absolutePath)) continue;
      if (entry.isDirectory()) {
        if (DEFAULT_EXCLUDED_DIRS.has(entry.name) || canPruneExcludedDirectory(path, excludeGlobs, excludeMatchers)) continue;
        try {
          const directoryStat = await lstat(absolutePath);
          if (!directoryStat.isDirectory()) continue;
        } catch {
          ioErrors += 1;
          return stop("io_error");
        }
        lastPath = path;
        await walk(absolutePath, depth + 1);
        continue;
      }
      // Dirent symlinks and special files intentionally do not enter traversal.
      if (!entry.isFile()) continue;
      // Apply the exclusive cursor marker before counting the bounded file
      // budget. Otherwise every continuation would spend its cap re-scanning
      // already-consumed candidates and could never advance.
      if (input.afterPath && (compareStrings(path, input.afterPath) < 0 || (!input.includeAfterPath && compareStrings(path, input.afterPath) === 0))) continue;
      filesConsidered += 1;
      if (filesConsidered > limits.maxFiles) return stop("max_files");
      lastFilePath = path;
      lastPath = path;
      if (excludeMatchers.length > 0 && matchesAny(excludeMatchers, path)) continue;
      if (includeMatchers.length > 0 && !matchesAny(includeMatchers, path)) continue;
      let bytes: number;
      try {
        const fileStat = await lstat(absolutePath);
        if (!fileStat.isFile()) continue;
        bytes = fileStat.size;
      } catch {
        ioErrors += 1;
        return stop("io_error");
      }
      entries.push({ path, absolutePath, bytes });
      if (entries.length >= limits.maxResults) return stop("max_results");
    }
  };

  await walk(input.rootPath, 0);
  entries.sort((a, b) => compareStrings(a.path, b.path));
  return {
    entries,
    filesConsidered,
    dirsVisited,
    truncated,
    ...(stoppedBy ? { stoppedBy } : {}),
    elapsedMs: Math.max(0, Date.now() - startedAt),
    ioErrors,
    ...(lastFilePath ? { lastFilePath } : {}),
    ...(lastPath ? { lastPath } : {}),
  };
}

export function normalizedGlobs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map(normalizeGlob).filter(Boolean))].sort(compareStrings);
}

/**
 * Canonical public glob fields win only when no replay-only alias is present.
 * Supplying both with different normalized values is an actionable argument
 * error; silently preferring one would make replayed calls non-deterministic.
 */
export function normalizeGlobArguments(
  args: Record<string, unknown>,
  canonicalKey: "include_globs" | "exclude_globs",
  legacyKey: "include" | "exclude",
): { ok: true; value: string[] } | { ok: false; error: "invalid_arguments"; message: string; recovery_hint: string } {
  const hasCanonical = Object.prototype.hasOwnProperty.call(args, canonicalKey);
  const hasLegacy = Object.prototype.hasOwnProperty.call(args, legacyKey);
  const validatePresent = (key: string, present: boolean): string[] | { error: "invalid_arguments"; message: string; recovery_hint: string } => {
    if (!present) return [];
    const value = args[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      return {
        error: "invalid_arguments",
        message: `${key} must be an array of strings when supplied.`,
        recovery_hint: `Provide ${key} as an array containing only workspace-relative glob strings.`,
      };
    }
    return normalizedGlobs(value);
  };
  const canonicalValue = validatePresent(canonicalKey, hasCanonical);
  if (Array.isArray(canonicalValue)) {
    const legacyValue = validatePresent(legacyKey, hasLegacy);
    if (!Array.isArray(legacyValue)) return { ok: false, ...legacyValue };
    const canonical = canonicalValue;
    const legacy = legacyValue;
    if (hasCanonical && hasLegacy && stableGlobValues(canonical) !== stableGlobValues(legacy)) {
      return {
        ok: false,
        error: "invalid_arguments",
        message: `${canonicalKey} and replay alias ${legacyKey} disagree after normalization.`,
        recovery_hint: `Provide only ${canonicalKey} with one canonical glob list.`,
      };
    }
    return { ok: true, value: hasCanonical ? canonical : legacy };
  }
  return { ok: false, ...canonicalValue };
}

function stableGlobValues(values: readonly string[]): string {
  return JSON.stringify(values);
}

export function normalizeTraversalLimits(input: Record<string, unknown>, defaults: Partial<WorkspaceTraversalLimits> = {}): WorkspaceTraversalLimits {
  return limitsFor({
    ...defaults,
    maxResults: (input.max_results ?? defaults.maxResults) as number | undefined,
    maxFiles: (input.max_files ?? defaults.maxFiles) as number | undefined,
    maxDirs: (input.max_dirs ?? defaults.maxDirs) as number | undefined,
    maxDepth: (input.max_depth ?? defaults.maxDepth) as number | undefined,
    elapsedMs: (input.timeout_ms ?? defaults.elapsedMs) as number | undefined,
  });
}
