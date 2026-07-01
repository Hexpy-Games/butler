import {
  deleteMcpServer,
  listMcpServers,
  updateMcpServer,
  upsertMcpServer,
} from "../../../../interfaces/mcp-client/registry.ts";
import {
  listMcpServerCapabilities,
  probeMcpServer,
} from "../../../../interfaces/mcp-client/client.ts";
import {
  importSkillZip,
  skillSettingsView,
} from "../../../../integrations/skills/manager.ts";
import {
  type McpCapabilitiesView,
  type McpServerDeleteResult,
  type McpServerListView,
  type McpServerMutationResult,
  type McpServerUpsertRequest,
  type ProjectSummary,
  type SkillImportResult,
  type SkillSettingsView,
} from "../../interface/protocol/app-protocol.ts";
import {
  readTranscriptFromDataHome,
} from "../sessions/transcript-reader.ts";
import {
  loadedSkillNamesFromTranscriptEvent,
} from "../../infrastructure/transport/app-transport-metadata.ts";
import { sessionHintForRow } from "../sessions/session-read-model.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";

export class AppIntegrationStore {
  constructor(
    private readonly butlerData: string,
    private readonly butlerHome: string,
    private readonly projects: () => ProjectSummary[],
  ) {}

  listMcpServers(): McpServerListView {
    return listMcpServers(this.butlerData);
  }

  createMcpServer(input: McpServerUpsertRequest): McpServerMutationResult {
    try {
      return { server: upsertMcpServer(this.butlerData, input) };
    } catch (error) {
      throw new AppStoreOperationError(
        400,
        "mcp_server_save_failed",
        error instanceof Error ? error.message : "MCP server save failed.",
      );
    }
  }

  updateMcpServer(
    serverId: string,
    input: McpServerUpsertRequest,
  ): McpServerMutationResult {
    try {
      return { server: updateMcpServer(this.butlerData, serverId, input) };
    } catch (error) {
      throw new AppStoreOperationError(
        error instanceof Error && error.message.includes("not found")
          ? 404
          : 400,
        "mcp_server_update_failed",
        error instanceof Error ? error.message : "MCP server update failed.",
      );
    }
  }

  deleteMcpServer(serverId: string): McpServerDeleteResult {
    return deleteMcpServer(this.butlerData, serverId);
  }

  async probeMcpServer(serverId: string): Promise<McpCapabilitiesView> {
    return {
      servers: [
        await probeMcpServer({
          butlerData: this.butlerData,
          serverId,
        }),
      ],
    };
  }

  async listMcpCapabilities(): Promise<McpCapabilitiesView> {
    return await listMcpServerCapabilities({
      butlerData: this.butlerData,
      includeDisabled: true,
    });
  }

  getSkillSettings(): SkillSettingsView {
    return skillSettingsView({
      butlerHome: this.butlerHome,
      butlerData: this.butlerData,
      projects: this.projects().map((project) => ({
        id: project.id,
        display_name: project.display_name,
      })),
    });
  }

  loadedSkillNamesForSession(sessionId: string, turnId?: string): string[] {
    const runtimeSessionId = sessionHintForRow(sessionId);
    const transcriptIds = [
      runtimeSessionId,
      ...(runtimeSessionId === sessionId ? [] : [sessionId]),
    ];
    for (const transcriptId of transcriptIds) {
      const events = readTranscriptFromDataHome(this.butlerData, transcriptId);
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const skillNames = loadedSkillNamesFromTranscriptEvent(
          events[index],
          turnId,
        );
        if (skillNames !== null) return skillNames;
      }
    }
    return [];
  }

  importSkill(input: {
    name: string;
    bytes: ArrayBuffer;
    projectId?: string;
  }): SkillImportResult {
    try {
      return importSkillZip({
        butlerData: this.butlerData,
        zipName: input.name,
        bytes: input.bytes,
        projectId: input.projectId,
      });
    } catch (error) {
      throw new AppStoreOperationError(
        400,
        "skill_import_failed",
        error instanceof Error ? error.message : "Skill import failed.",
      );
    }
  }
}
