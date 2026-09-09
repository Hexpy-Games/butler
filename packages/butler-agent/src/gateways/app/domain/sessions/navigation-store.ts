import type {
  AutomationListView,
  CommandPaletteView,
  NavigationView,
  ProjectListView,
  SessionListView,
  SettingsView,
} from "../../interface/protocol/app-protocol.ts";
import type { AppSpaceOrganization } from "./space-organization.ts";

export class AppNavigationStore {
  constructor(
    private readonly space: AppSpaceOrganization,
    private readonly listAutomations: () => AutomationListView,
    private readonly getSettings: () => SettingsView,
    private readonly listSessions: () => SessionListView,
    private readonly listChatSessions: () => SessionListView,
    private readonly listProjects: () => ProjectListView,
    private readonly listProjectsWithSessions: () => ProjectListView,
  ) {}

  listNavigation(): NavigationView {
    const automations = this.listAutomations().automations;
    const settings = this.getSettings();
    return {
      space: this.space.read(),
      chats: this.listChatSessions().sessions,
      projects: this.listProjectsWithSessions().projects,
      automations_summary: {
        total_count: automations.length,
        enabled_count: automations.filter(
          (automation) => automation.state === "enabled",
        ).length,
      },
      settings_summary: {
        profile_label: settings.profile_label,
      },
      generated_at: new Date().toISOString(),
    };
  }

  searchCommandPalette(query: string): CommandPaletteView {
    const space = this.space.read();
    const projects = this.listProjects().projects;
    const sessions = this.listSessions().sessions;
    const visibleProjects = new Set(projects.filter(project => !project.archived).map(project => project.id));
    const groupNames = new Map(space.groups.map(group => [group.id, group.title]));
    const projectNames = new Map(projects.map(project => [project.id, project.display_name]));
    const nodes = new Map(space.nodes.map(node => [node.key, node]));
    const location = (key: string) => {
      const names: string[] = [];
      let parentKey = nodes.get(key)?.parentKey;
      while (parentKey) {
        const parent = nodes.get(parentKey);
        if (!parent) break;
        names.unshift((parent.kind === "project" ? projectNames.get(parent.entityId) : groupNames.get(parent.entityId)) ?? "");
        parentKey = parent.parentKey;
      }
      return names.join(" › ");
    };
    const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase();
    const needle = normalize(query.trim());
    const terms = needle.split(/\s+/u).filter(Boolean);
    const matches = (value: string) =>
      terms.every(term => normalize(value).includes(term));
    const results = [
      ...sessions.filter((session) => !session.archived && (!session.project_id || visibleProjects.has(session.project_id)) && matches(`${session.title} ${location(`s:${session.id}`)}`))
        .map((session) => ({
          id: session.id,
          kind:
            session.kind === "project"
              ? ("project_session" as const)
              : ("chat" as const),
          title: session.title,
          subtitle: location(`s:${session.id}`) || (session.kind === "project" ? "Project chat" : "Chat"),
          route: `session:${session.id}`,
        })),
      ...projects.filter((project) => !project.archived && matches(`${project.display_name} ${location(`p:${project.id}`)}`))
        .map((project) => ({
          id: project.id,
          kind: "project" as const,
          title: project.display_name,
          subtitle: location(`p:${project.id}`) || "Project",
          route: `project:${project.id}`,
        })),
      ...space.groups.filter(group => (!group.scopeProjectId || visibleProjects.has(group.scopeProjectId)) && matches(`${group.title} ${location(`g:${group.id}`)}`)).map(group => ({
        id: group.id, kind: "group" as const, title: group.title,
        subtitle: location(`g:${group.id}`) || "스페이스", route: `group:${group.id}`,
      })),
      ...this.listAutomations()
        .automations.filter((automation) => matches(automation.title))
        .map((automation) => ({
          id: automation.id,
          kind: "automation" as const,
          title: automation.title,
          subtitle: automation.interval_label,
          route: `automation:${automation.id}`,
        })),
      ...[
        "General",
        "Appearance",
        "Server/Bridge",
        "Models/Access",
        "Privacy/Data",
        "Diagnostics",
        "System events",
        "Archived",
      ]
        .filter(matches)
        .map((section) => ({
          id: `settings:${section.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-")}`,
          kind: "settings" as const,
          title: section,
          subtitle: "Settings",
          route: `settings:${section}`,
        })),
    ];
    const recency = new Map([
      ...sessions.map(session => [session.id, session.last_activity_at] as const),
      ...projects.map(project => [project.id, project.last_activity_at] as const),
    ]);
    const rank = (title: string) => normalize(title) === needle ? 0 : normalize(title).startsWith(needle) ? 1 : 2;
    results.sort((a, b) => rank(a.title) - rank(b.title) ||
      (recency.get(b.id) ?? "").localeCompare(recency.get(a.id) ?? "") || a.id.localeCompare(b.id));
    return { results: results.slice(0, 30) };
  }
}
