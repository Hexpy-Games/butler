import type { NavigationView } from "./types.ts";

const GROUP_DRAFT_PREFIX = "draft:group:";

/** A new-chat draft whose session is created inside a sidebar group. */
export function groupDraftId(groupId: string): string {
  return `${GROUP_DRAFT_PREFIX}${groupId}`;
}

export function draftGroupId(value: string): string | undefined {
  return value?.startsWith(GROUP_DRAFT_PREFIX) ? value.slice(GROUP_DRAFT_PREFIX.length) || undefined : undefined;
}

export interface DraftGroup {
  groupId: string;
  /** The group's project scope: the new session is a chat of this project. */
  projectId?: string;
  projectName?: string;
  /** Where the session lands, outermost first (`Project › Group`). */
  location: string;
}

export function draftGroup(navigation: NavigationView, groupId: string): DraftGroup | null {
  const group = navigation.space.groups.find((item) => item.id === groupId);
  if (!group) return null;
  const nodes = new Map(navigation.space.nodes.map((node) => [node.key, node]));
  const groups = new Map(navigation.space.groups.map((item) => [item.id, item.title]));
  const projects = new Map((navigation.projects ?? []).map((project) => [project.id, project.display_name]));
  const names: string[] = [];
  for (let node = nodes.get(`g:${groupId}`); node; node = node.parentKey ? nodes.get(node.parentKey) : undefined) {
    const name = node.kind === "project" ? projects.get(node.entityId) : groups.get(node.entityId);
    if (name) names.unshift(name);
  }
  const projectId = group.scopeProjectId ?? undefined;
  return {
    groupId,
    projectId,
    projectName: projectId ? projects.get(projectId) : undefined,
    location: names.join(" › ") || group.title,
  };
}
