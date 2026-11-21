import type { CanonSidebar, EpicCard, NavigationView, ProjectSummary, SessionSummary } from "../../../butler-protocol/src/index.ts";

export type SpaceRow = {
  key: string;
  kind: "session" | "project" | "group" | "plan" | "backlog" | "epic";
  title: string;
  session?: SessionSummary;
  project?: ProjectSummary;
  epic?: EpicCard;
  depth: number;
};

export function spaceTree(view: NavigationView): { general?: SessionSummary; children: Map<string | null, SpaceRow[]> } {
  const sessions = new Map([...view.chats, ...view.projects.flatMap(project => project.sessions ?? [])].map(session => [session.id, session]));
  const projects = new Map(view.projects.map(project => [project.id, project]));
  const groups = new Map(view.space.groups.map(group => [group.id, group]));
  const nodes = new Map(view.space.nodes.map(node => [node.key, node]));
  const children = new Map<string | null, SpaceRow[]>();
  const visibleProjects = new Set<string>();
  for (const node of nodes.values()) {
    const session = node.kind === "session" ? sessions.get(node.entityId) : undefined;
    const project = node.kind === "project" ? projects.get(node.entityId) : undefined;
    const title = node.kind === "session" ? session?.title : node.kind === "project" ? project?.display_name : groups.get(node.entityId)?.title;
    if (title === undefined || (node.kind !== "session" && !title) || session?.archived || project?.archived || session?.id === "general") continue;
    let parent = node.parentKey ? nodes.get(node.parentKey) : undefined;
    let hidden = false;
    while (parent) {
      if (parent.kind === "project" && projects.get(parent.entityId)?.archived) hidden = true;
      parent = parent.parentKey ? nodes.get(parent.parentKey) : undefined;
    }
    if (hidden) continue;
    const siblings = children.get(node.parentKey) ?? [];
    siblings.push({ key: node.key, kind: node.kind, title, session, project, depth: 0 });
    children.set(node.parentKey, siblings);
    if (project) visibleProjects.add(node.key);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => nodes.get(a.key)!.position - nodes.get(b.key)!.position || a.key.localeCompare(b.key));
  }
  const unplaced = [...sessions.values()].filter(session => !session.archived && session.id !== "general"
    && !nodes.has(`s:${session.id}`) && !projects.get(session.project_id ?? "")?.archived);
  unplaced.sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
  for (const session of unplaced) {
    const projectKey = `p:${session.project_id}`;
    const parentKey = visibleProjects.has(projectKey) ? projectKey : null;
    const siblings = children.get(parentKey) ?? [];
    siblings.push({ key: `s:${session.id}`, kind: "session", title: session.title, session, depth: 0 });
    children.set(parentKey, siblings);
  }
  return { general: view.chats.find(session => session.id === "general" && !session.archived), children };
}

/** Desktop's project contents: Canon groups first (backlog, then plans), each holding its 과제; a chat that worked only on one 과제 (and is not its home) nests under it and leaves the project's list. */
export function withCanon(tree: ReturnType<typeof spaceTree>, sidebars: ReadonlyMap<string, CanonSidebar>, backlogTitle: string): ReturnType<typeof spaceTree> {
  const children = new Map(tree.children);
  const rows = new Map([...tree.children.values()].flatMap(siblings => siblings.map(row => [row.key, row] as const)));
  for (const [projectId, sidebar] of sidebars) {
    const projectKey = `p:${projectId}`;
    if (!rows.has(projectKey)) continue;
    const nested = new Set<string>();
    const groupRows: SpaceRow[] = [];
    for (const group of sidebar.groups) {
      if (!group.rows.length) continue;
      const epicRows = group.rows.map((epic): SpaceRow => {
        const sessions = epic.sessions.flatMap(session => {
          const row = rows.get(`s:${session.session_id}`);
          if (session.worked !== 1 || session.session_id === epic.home_session_id || !row) return [];
          nested.add(row.key);
          return [row];
        });
        const row: SpaceRow = { key: `e:${epic.id}`, kind: "epic", title: epic.title, epic, depth: 0 };
        children.set(row.key, sessions);
        return row;
      });
      const row: SpaceRow = { key: `c:${projectId}:${group.key}`, kind: group.kind, title: group.kind === "backlog" ? backlogTitle : group.title ?? "", depth: 0 };
      children.set(row.key, epicRows);
      groupRows.push(row);
    }
    children.set(projectKey, [...groupRows, ...(children.get(projectKey) ?? []).filter(row => !nested.has(row.key))]);
  }
  return { general: tree.general, children };
}

export function visibleRows(tree: ReturnType<typeof spaceTree>, collapsed: ReadonlySet<string>): SpaceRow[] {
  const rows: SpaceRow[] = [];
  const visit = (parent: string | null, depth: number) => {
    for (const row of tree.children.get(parent) ?? []) {
      rows.push({ ...row, depth });
      if (!collapsed.has(row.key)) visit(row.key, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}
