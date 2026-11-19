import type { NavigationView, ProjectSummary, SessionSummary } from "../../../butler-protocol/src/index.ts";

export type SpaceRow = {
  key: string;
  kind: "session" | "project" | "group";
  title: string;
  session?: SessionSummary;
  project?: ProjectSummary;
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
