import type { ModelCatalogView } from "../../../../integrations/providers/model-catalog.ts";
import type {
  HostedModelDeletionResult,
  HostedModelRegistrationRequest,
  HostedModelRegistrationResult,
  LocalModelDeletionResult,
  LocalModelDiscoveryRequest,
  LocalModelDiscoveryResult,
  LocalModelRegistrationRequest,
  LocalModelRegistrationResult,
  LocalModelUpdateRequest,
  McpCapabilitiesView,
  McpServerDeleteResult,
  McpServerListView,
  McpServerMutationResult,
  McpServerUpsertRequest,
  PersonalizationProfileMigrationRequest,
  PersonalizationProfileMigrationResultView,
  PersonalizationView,
  ProviderCredentialMutationResult,
  ProviderCredentialUpsertRequest,
  SettingsView,
  SkillImportResult,
  SkillSettingsView,
  UpdatePersonalizationRequest,
  UpdateSettingsRequest,
} from "../../interface/protocol/app-protocol.ts";
import type { AppStoreKernel } from "../kernel/app-store-kernel.ts";

export interface AppStoreSettingsApi {
  getSettings(): SettingsView;
  updateSettings(input: UpdateSettingsRequest): SettingsView;
  getModelCatalog(): ModelCatalogView;
  upsertProviderCredential(
    input: ProviderCredentialUpsertRequest,
  ): ProviderCredentialMutationResult;
  registerHostedModel(
    input: HostedModelRegistrationRequest,
  ): HostedModelRegistrationResult;
  deleteHostedModel(modelRef: string): HostedModelDeletionResult;
  discoverLocalModels(
    input: LocalModelDiscoveryRequest,
  ): Promise<LocalModelDiscoveryResult>;
  registerLocalModel(
    input: LocalModelRegistrationRequest,
  ): LocalModelRegistrationResult;
  updateLocalModel(
    modelRef: string,
    input: LocalModelUpdateRequest,
  ): LocalModelRegistrationResult;
  deleteLocalModel(modelRef: string): LocalModelDeletionResult;
  listMcpServers(): McpServerListView;
  createMcpServer(input: McpServerUpsertRequest): McpServerMutationResult;
  updateMcpServer(
    serverId: string,
    input: McpServerUpsertRequest,
  ): McpServerMutationResult;
  deleteMcpServer(serverId: string): McpServerDeleteResult;
  probeMcpServer(serverId: string): Promise<McpCapabilitiesView>;
  listMcpCapabilities(): Promise<McpCapabilitiesView>;
  getSkillSettings(): SkillSettingsView;
  importSkill(input: {
    name: string;
    bytes: ArrayBuffer;
    projectId?: string;
  }): SkillImportResult;
  getPersonalization(): PersonalizationView;
  updatePersonalization(
    input: UpdatePersonalizationRequest,
  ): PersonalizationView;
  importPersonalizationProfile(
    input: PersonalizationProfileMigrationRequest,
  ): Promise<PersonalizationProfileMigrationResultView>;
}

export function createSettingsStoreApi(
  kernel: AppStoreKernel,
): AppStoreSettingsApi {
  return {
    getSettings() {
      return kernel.preferences.getSettings();
    },
    updateSettings(input) {
      return kernel.preferences.updateSettings(input);
    },
    getModelCatalog() {
      return kernel.modelRegistry.getModelCatalog();
    },
    upsertProviderCredential(input) {
      return kernel.modelRegistry.upsertProviderCredential(input);
    },
    registerHostedModel(input) {
      return kernel.modelRegistry.registerHostedModel(input);
    },
    deleteHostedModel(modelRef) {
      return kernel.modelRegistry.deleteHostedModel(modelRef);
    },
    async discoverLocalModels(input) {
      return await kernel.modelRegistry.discoverLocalModels(input);
    },
    registerLocalModel(input) {
      return kernel.modelRegistry.registerLocalModel(input);
    },
    updateLocalModel(modelRef, input) {
      return kernel.modelRegistry.updateLocalModel(modelRef, input);
    },
    deleteLocalModel(modelRef) {
      return kernel.modelRegistry.deleteLocalModel(modelRef);
    },
    listMcpServers() {
      return kernel.integrations.listMcpServers();
    },
    createMcpServer(input) {
      return kernel.integrations.createMcpServer(input);
    },
    updateMcpServer(serverId, input) {
      return kernel.integrations.updateMcpServer(serverId, input);
    },
    deleteMcpServer(serverId) {
      return kernel.integrations.deleteMcpServer(serverId);
    },
    async probeMcpServer(serverId) {
      return await kernel.integrations.probeMcpServer(serverId);
    },
    async listMcpCapabilities() {
      return await kernel.integrations.listMcpCapabilities();
    },
    getSkillSettings() {
      return kernel.integrations.getSkillSettings();
    },
    importSkill(input) {
      return kernel.integrations.importSkill(input);
    },
    getPersonalization() {
      return kernel.personalization.get();
    },
    updatePersonalization(input) {
      return kernel.personalization.update(input);
    },
    async importPersonalizationProfile(input) {
      return await kernel.personalization.importProfile(input);
    },
  };
}
