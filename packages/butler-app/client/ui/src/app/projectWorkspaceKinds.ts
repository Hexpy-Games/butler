import type { SessionView } from "./types.ts";

/** Whether a project folder is a Git repository, as its sessions last reported. */
export type ProjectWorkspaceKind = "git" | "folder";
export type ProjectWorkspaceKinds = Readonly<Record<string, ProjectWorkspaceKind>>;

const CACHE_SCHEMA = "butler.project-workspace-kinds.v1";
const CACHE_KEY = "butler:project-workspace-kinds:v1";
const EMPTY: ProjectWorkspaceKinds = Object.freeze({});

/**
 * Projects have no workspace kind until one of their sessions reports it, so
 * the kind is learned from loaded session views. Unknown or unavailable
 * workspaces keep the last definite answer. Returns `known` when unchanged.
 */
export function learnProjectWorkspaceKinds(
  known: ProjectWorkspaceKinds,
  views: Iterable<Pick<SessionView, "project_id" | "branch">>,
): ProjectWorkspaceKinds {
  let next: Record<string, ProjectWorkspaceKind> | null = null;
  for (const view of views) {
    const mode = view.branch?.workspace_mode;
    if (!view.project_id || (mode !== "git" && mode !== "folder")) continue;
    if ((next ?? known)[view.project_id] === mode) continue;
    next ??= { ...known };
    next[view.project_id] = mode;
  }
  return next ?? known;
}

export function readCachedProjectWorkspaceKinds(): ProjectWorkspaceKinds {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { schema?: unknown; kinds?: unknown }) : null;
    if (parsed?.schema !== CACHE_SCHEMA || !parsed.kinds || typeof parsed.kinds !== "object") {
      return EMPTY;
    }
    return Object.fromEntries(
      Object.entries(parsed.kinds).filter(
        (entry): entry is [string, ProjectWorkspaceKind] => entry[1] === "git" || entry[1] === "folder",
      ),
    );
  } catch {
    return EMPTY;
  }
}

export function writeCachedProjectWorkspaceKinds(kinds: ProjectWorkspaceKinds): void {
  try {
    globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify({ schema: CACHE_SCHEMA, kinds }));
  } catch {
    // The cache only saves a lookup after restart; a new session view restores it.
  }
}
