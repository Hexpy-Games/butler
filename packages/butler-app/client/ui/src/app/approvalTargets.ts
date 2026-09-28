import type { ApprovalTarget } from "./types.ts";

/**
 * Transport field names of an approval target, in order of preference. #277's
 * security review moves targets from one absolute `path` to a workspace label
 * plus a path relative to it; the final names land with #277, so adjust them
 * here only.
 */
export const APPROVAL_TARGET_FIELDS = {
  label: ["workspace_label", "label"],
  path: ["path", "relative_path"],
} as const;

const ABSOLUTE_PATH = /^(?:\/|~(?:[\\/]|$)|[A-Za-z]:[\\/]|\\\\)/u;
const TRAILING_SEPARATORS = /(?<=.)[\\/]+$/u;

export function isAbsolutePath(path: string): boolean {
  return ABSOLUTE_PATH.test(path.trim());
}

function lastSegment(path: string): string {
  return path.replace(TRAILING_SEPARATORS, "").split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
}

function firstString(record: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    if (typeof record[name] === "string") return record[name];
  }
  return undefined;
}

/** `path` inside `root`, relative to it; `undefined` when it lies elsewhere. */
function within(path: string, root: string | undefined): string | undefined {
  if (!root || !path.startsWith(root)) return undefined;
  const rest = path.slice(root.length);
  if (rest && !/^[\\/]/u.test(rest)) return undefined;
  return rest.replace(/^[\\/]+/u, "");
}

/**
 * Normalizes transport targets. Both shapes are accepted: the old `{kind,
 * path}` with an absolute path, and the new `{kind, workspace_label, path}`
 * with a path relative to the workspace. Nothing absolute survives: an old
 * absolute folder becomes its label, and every other absolute path becomes
 * relative to that folder, else its last part. `relative` applies the same
 * rule to example paths.
 */
export function approvalTargetsFromTransport(value: unknown): {
  targets: ApprovalTarget[];
  relative: (path: string) => string;
} {
  const raw = (Array.isArray(value) ? value : []).flatMap((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) return [];
    const record = target as Record<string, unknown>;
    const path = firstString(record, APPROVAL_TARGET_FIELDS.path);
    return typeof record.kind === "string" && path !== undefined
      ? [{ kind: record.kind, label: firstString(record, APPROVAL_TARGET_FIELDS.label), path: path.trim() }]
      : [];
  });
  // The old shape's workspace: its first absolute folder.
  const root = raw.find((target) => target.kind === "folder" && isAbsolutePath(target.path))?.path
    .replace(TRAILING_SEPARATORS, "");
  const relative = (path: string) => {
    const trimmed = path.trim();
    if (!isAbsolutePath(trimmed)) return trimmed === "." ? "" : trimmed.replace(/^\.[\\/]/u, "");
    return within(trimmed.replace(TRAILING_SEPARATORS, ""), root) ?? lastSegment(trimmed);
  };
  const targets = raw.map(({ kind, label, path }) => {
    const shown = label?.trim() ? (isAbsolutePath(label) ? lastSegment(label) : label.trim()) : undefined;
    const workspace = shown ?? (kind === "folder" && isAbsolutePath(path) ? lastSegment(path) : undefined);
    // An old absolute folder is the workspace itself (or a folder inside it).
    const inside = kind === "folder" && isAbsolutePath(path)
      ? within(path.replace(TRAILING_SEPARATORS, ""), root) ?? "" : relative(path);
    return { kind, path: inside, ...(workspace ? { label: workspace } : {}) };
  });
  return { targets, relative };
}
