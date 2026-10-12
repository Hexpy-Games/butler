import type { ApprovalTarget } from "./types.ts";

const ABSOLUTE_PATH = /^(?:\/|~(?:[\\/]|$)|[A-Za-z]:[\\/]|\\\\)/u;
const TRAILING_SEPARATORS = /(?<=.)[\\/]+$/u;

export function isAbsolutePath(path: string): boolean {
  return ABSOLUTE_PATH.test(path.trim());
}

/** `path` inside `root`, relative to it; `undefined` when it lies elsewhere. */
function within(path: string, root: string | undefined): string | undefined {
  if (!root || !path.startsWith(root)) return undefined;
  const rest = path.slice(root.length);
  if (rest && !/^[\\/]/u.test(rest)) return undefined;
  if (rest.split(/[\\/]/u).includes("..")) return undefined;
  return rest.replace(/^[\\/]+/u, "");
}

/** Keep project-relative paths inside the root and exact paths elsewhere. */
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
    return within(trimmed.replace(TRAILING_SEPARATORS, ""), root) ?? trimmed;
  };
  const targets = raw.map(({ kind, path }): ApprovalTarget => {
    if (kind !== "folder") return { kind, path: relative(path) };
    const label = path.replace(TRAILING_SEPARATORS, "").replace(/^\.$/u, "");
    return { kind, path: "", ...(label ? { label } : {}) };
  });
  return { targets, relative };
}
