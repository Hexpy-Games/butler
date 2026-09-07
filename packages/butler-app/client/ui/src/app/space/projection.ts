import type {
  NavigationView,
  SpaceNode,
  SessionSummary,
  ProjectSummary,
} from "../types";

export interface SpaceRowData {
  node: SpaceNode;
  title: string;
  session?: SessionSummary;
  project?: ProjectSummary;
  pinned: boolean;
  smart: boolean;
  location: string;
  updatedAt: string;
  ancestors: string[];
}

const projections = new WeakMap<NavigationView, Map<string, SpaceRowData>>();
const childrenIndexes = new WeakMap<Map<string, SpaceRowData>, Map<string | null, SpaceRowData[]>>();
let previousRows = new Map<string, SpaceRowData>();
let previousChildren = new Map<string | null, SpaceRowData[]>();

/** Build the visible navigation once; rows never infer ownership from position. */
export function projectSpace(
  navigation: NavigationView,
): Map<string, SpaceRowData> {
  const cached = projections.get(navigation);
  if (cached) return cached;
  const sessions = new Map(
    [
      ...navigation.chats,
      ...navigation.projects.flatMap((p) => p.sessions ?? []),
    ].map((s) => [s.id, s]),
  );
  const projects = new Map(navigation.projects.map((p) => [p.id, p]));
  const groups = new Map(navigation.space.groups.map((g) => [g.id, g]));
  const nodes = new Map(navigation.space.nodes.map((n) => [n.key, n]));
  const title = (n: SpaceNode) =>
    n.kind === "session"
      ? sessions.get(n.entityId)?.title
      : n.kind === "project"
        ? projects.get(n.entityId)?.display_name
        : groups.get(n.entityId)?.title;
  const rows = new Map<string, SpaceRowData>();
  const general = sessions.get("general");
  if (general)
    rows.set("s:general", {
      node: {
        key: "s:general",
        kind: "session",
        entityId: "general",
        parentKey: null,
        position: -1,
        revision: 0,
        manualPlacement: false,
        scopeProjectId: null,
      },
      title: "일반",
      session: general,
      pinned: false,
      smart: false,
      location: "일반",
      updatedAt: general.last_activity_at,
      ancestors: [],
    });
  for (const node of nodes.values()) {
    const session =
      node.kind === "session" ? sessions.get(node.entityId) : undefined;
    const project =
      node.kind === "project" ? projects.get(node.entityId) : undefined;
    if (!title(node) || session?.archived || project?.archived) continue;
    let parent = node.parentKey ? nodes.get(node.parentKey) : undefined;
    const path: string[] = [];
    const ancestors: string[] = [];
    let hidden = false;
    while (parent) {
      ancestors.unshift(parent.key);
      if (parent.kind === "project" && projects.get(parent.entityId)?.archived)
        hidden = true;
      path.unshift(title(parent) ?? "");
      parent = parent.parentKey ? nodes.get(parent.parentKey) : undefined;
    }
    if (hidden) continue;
    rows.set(node.key, {
      node,
      title: title(node)!,
      session,
      project,
      pinned: session?.pinned ?? project?.pinned ?? false,
      smart: groups.get(node.entityId)?.origin === "smart",
      location: path.join(" › ") || "스페이스",
      updatedAt: session?.last_activity_at ?? project?.last_activity_at ?? "",
      ancestors,
    });
  }
  const children = new Map<string | null, SpaceRowData[]>();
  for (const [key, row] of rows) {
    const old = previousRows.get(key);
    if (old && JSON.stringify(old) === JSON.stringify(row)) rows.set(key, old);
    if (key === "s:general") continue;
    const siblings = children.get(row.node.parentKey) ?? [];
    siblings.push(rows.get(key)!);
    children.set(row.node.parentKey, siblings);
  }
  for (const [key, siblings] of children) {
    siblings.sort((a, b) => a.node.position - b.node.position || a.node.key.localeCompare(b.node.key));
    const old = previousChildren.get(key);
    if (old?.length === siblings.length && old.every((row, i) => row === siblings[i])) children.set(key, old);
  }
  projections.set(navigation, rows);
  childrenIndexes.set(rows, children);
  previousRows = rows;
  previousChildren = children;
  return rows;
}

const EMPTY_CHILDREN: SpaceRowData[] = [];

export function spaceChildren(
  rows: Map<string, SpaceRowData>,
  parentKey: string | null,
): SpaceRowData[] {
  return childrenIndexes.get(rows)?.get(parentKey) ?? EMPTY_CHILDREN;
}
