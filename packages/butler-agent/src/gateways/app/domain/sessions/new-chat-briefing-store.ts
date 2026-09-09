import { buildNewChatBriefing } from "../new-chat-briefing/build-new-chat-briefing.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import type { ProjectRow } from "../../infrastructure/core/records.ts";
import type { NewChatBriefingView, SettingsView } from "../../interface/protocol/app-protocol.ts";
import type { DashboardMaterialsPage } from "../../interface/protocol/session-dashboard-contract.ts";

export class AppNewChatBriefingStore {
  constructor(
    private readonly input: {
      butlerData: string;
      getSettings: () => SettingsView;
      getProjectRow: (projectId: string) => ProjectRow | null;
      getProjectMaterials: (projectId: string) => Promise<DashboardMaterialsPage>;
    },
  ) {}

  async get(
    options: { date?: string | null; projectId?: string | null } = {},
  ): Promise<NewChatBriefingView> {
    const settings = this.input.getSettings();
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
      ? await this.input.getProjectMaterials(project.id)
      : null;
    return buildNewChatBriefing({
      butlerData: this.input.butlerData,
      preferredLocale: settings.language === "ko" ? "ko" : "en",
      date: options.date,
      project: project
        ? {
            id: project.id,
            displayName: project.display_name,
            documents: projectDocumentCatalog?.status === "ready" ? projectDocumentCatalog.documents.map((doc) => ({
              title: doc.title, category: doc.kind, status: doc.status, safePathLabel: doc.safe_path_label, markdown: "",
            })) : [],
          }
        : undefined,
    });
  }
}
