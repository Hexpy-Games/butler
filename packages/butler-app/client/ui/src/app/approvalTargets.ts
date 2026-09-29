import type { ApprovalTarget } from "./types.ts";

const ABSOLUTE_PATH = /^(?:\/|~(?:[\\/]|$)|[A-Za-z]:[\\/]|\\\\)/u;
const TRAILING_SEPARATORS = /(?<=.)[\\/]+$/u;

export function isAbsolutePath(path: string): boolean {
  return ABSOLUTE_PATH.test(path.trim());
}

function lastSegment(path: string): string {
  return path.replace(TRAILING_SEPARATORS, "").split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
}

/** `path` inside `root`, relative to it; `undefined` when it lies elsewhere. */
function within(path: string, root: string | undefined): string | undefined {
  if (!root || !path.startsWith(root)) return undefined;
  const rest = path.slice(root.length);
  if (rest && !/^[\\/]/u.test(rest)) return undefined;
  return rest.replace(/^[\\/]+/u, "");
}

/**
 * Normalizes transport targets (#277): a folder's `path` is its label
 * (`garden`, or `garden/app` for a folder inside it), and file paths are
 * relative to the workspace. The folder label moves to `label`, leaving the
 * folder's own `path` empty.
 *
 * #277 never sends an absolute path; as a safety net, none survives here
 * either: an absolute folder becomes its last part, and every other absolute
 * path becomes relative to that folder, else its last part. `relative`
 * applies the same rule to example paths.
 */
export function approvalTargetsFromTransport(value: unknown): {
  targets: ApprovalTarget[];
  relative: (path: string) => string;
} {
  const raw = (Array.isArray(value) ? value : []).flatMap((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) return [];
    const { kind, path } = target as Record<string, unknown>;
    return typeof kind === "string" && typeof path === "string" ? [{ kind, path: path.trim() }] : [];
  });
  const root = raw.find((target) => target.kind === "folder" && isAbsolutePath(target.path))?.path
    .replace(TRAILING_SEPARATORS, "");
  const relative = (path: string) => {
    const trimmed = path.trim();
    if (!isAbsolutePath(trimmed)) return trimmed === "." ? "" : trimmed.replace(/^\.[\\/]/u, "");
    return within(trimmed.replace(TRAILING_SEPARATORS, ""), root) ?? lastSegment(trimmed);
  };
  const targets = raw.map(({ kind, path }): ApprovalTarget => {
    if (kind !== "folder") return { kind, path: relative(path) };
    const label = isAbsolutePath(path) ? lastSegment(path) : path.replace(TRAILING_SEPARATORS, "").replace(/^\.$/u, "");
    return { kind, path: "", ...(label ? { label } : {}) };
  });
  return { targets, relative };
}
