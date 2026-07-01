import { buildNewChatBriefing } from "../new-chat-briefing/build-new-chat-briefing.ts";
import { loadProjectDocumentCatalog } from "../projects/project-document-catalog.ts";
import { readConfigUserSettings } from "../settings/settings-config.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import type { ProjectRow } from "../../infrastructure/core/records.ts";
import type { NewChatBriefingView, SettingsView } from "../../interface/protocol/app-protocol.ts";

export class AppNewChatBriefingStore {
  constructor(
    private readonly input: {
      butlerData: string;
      getSettings: () => SettingsView;
      getProjectRow: (projectId: string) => ProjectRow | null;
    },
  ) {}

  get(
    options: { date?: string | null; projectId?: string | null } = {},
  ): NewChatBriefingView {
    const settings = this.input.getSettings();
    const configUserSettings = readConfigUserSettings(this.input.butlerData);
    const projectId = options.projectId?.trim();
    const project = projectId ? this.input.getProjectRow(projectId) : null;
    if (projectId && !project) {
      throw new AppStoreOperationError(
        404,
        "project_not_found",
        "Project not found.",
      );
    }
    const projectDocumentCatalog = project
      ? loadProjectDocumentCatalog({
          butlerDataRoot: this.input.butlerData,
          project,
        })
      : null;
    return buildNewChatBriefing({
      butlerData: this.input.butlerData,
      preferredLocale:
        configUserSettings.responseLanguage ??
        (settings.language === "ko" ? "ko" : "en"),
      date: options.date,
      project: project
        ? {
            id: project.id,
            displayName: project.display_name,
            documents: projectDocumentCatalog?.briefingDocuments,
          }
        : undefined,
    });
  }
}
