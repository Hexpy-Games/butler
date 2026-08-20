import type {
  AutomationListView,
  CommandPaletteView,
  NavigationView,
  ProjectListView,
  SessionListView,
  SettingsView,
} from "../../interface/protocol/app-protocol.ts";

export class AppNavigationStore {
  constructor(
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
    const needle = query.trim().toLocaleLowerCase("en-US");
    const matches = (value: string) =>
      !needle || value.toLocaleLowerCase("en-US").includes(needle);
    const results = [
      ...this.listSessions()
        .sessions.filter((session) => matches(session.title))
        .map((session) => ({
          id: session.id,
          kind:
            session.kind === "project"
              ? ("project_session" as const)
              : ("chat" as const),
          title: session.title,
          subtitle: session.kind === "project" ? "Project chat" : "Chat",
          route: `session:${session.id}`,
        })),
      ...this.listProjects()
        .projects.filter((project) => matches(project.display_name))
        .map((project) => ({
          id: project.id,
          kind: "project" as const,
          title: project.display_name,
          subtitle: "Project",
          route: `project:${project.id}`,
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
    return { results: results.slice(0, 30) };
  }
}
