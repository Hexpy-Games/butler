import {
  modelCatalogView,
  type ModelCatalogView,
  type ProviderModelMetadata,
} from "../../../../integrations/providers/model-catalog.ts";
import {
  type HostedModelDeletionResult,
  type HostedModelRegistrationRequest,
  type HostedModelRegistrationResult,
  type LocalModelDeletionResult,
  type LocalModelDiscoveryRequest,
  type LocalModelDiscoveryResult,
  type LocalModelRegistrationRequest,
  type LocalModelRegistrationResult,
  type LocalModelUpdateRequest,
  type ProviderCredentialMutationResult,
  type ProviderCredentialUpsertRequest,
} from "../../interface/protocol/app-protocol.ts";
import { readConfigDefaultModel } from "../settings/settings-config.ts";
import type { AppModelSettingsPolicy } from "../integrations/model-settings-policy.ts";
import { AppHostedModelRegistryStore } from "./hosted-model-registry-store.ts";
import { AppLocalModelRegistryStore } from "./local-model-registry-store.ts";

export class AppModelRegistryStore {
  private readonly hosted: AppHostedModelRegistryStore;
  private readonly local: AppLocalModelRegistryStore;

  constructor(
    private readonly butlerData: string,
    policy: AppModelSettingsPolicy,
    appendEvent: (
      type: string,
      payload: Record<string, unknown>,
    ) => void,
  ) {
    this.hosted = new AppHostedModelRegistryStore(
      butlerData,
      policy,
      appendEvent,
      () => this.getModelCatalog(),
      () => this.registeredModelMetadata(),
    );
    this.local = new AppLocalModelRegistryStore(
      butlerData,
      policy,
      appendEvent,
      () => this.getModelCatalog(),
    );
  }

  localModelMetadata(): ProviderModelMetadata[] {
    return this.local.metadata();
  }

  registeredModelMetadata(): ProviderModelMetadata[] {
    return [...this.hosted.metadata(), ...this.localModelMetadata()];
  }

  getModelCatalog(): ModelCatalogView {
    const localModels = this.localModelMetadata();
    return modelCatalogView(
      localModels,
      [...this.hosted.metadata(), ...localModels],
      this.hosted.providerCredentialViews(),
      { defaultModelRef: readConfigDefaultModel(this.butlerData) },
    );
  }

  upsertProviderCredential(
    input: ProviderCredentialUpsertRequest,
  ): ProviderCredentialMutationResult {
    return this.hosted.upsertProviderCredential(input);
  }

  registerHostedModel(
    input: HostedModelRegistrationRequest,
  ): HostedModelRegistrationResult {
    return this.hosted.registerHostedModel(input);
  }

  deleteHostedModel(modelRef: string): HostedModelDeletionResult {
    return this.hosted.deleteHostedModel(modelRef);
  }

  async discoverLocalModels(
    input: LocalModelDiscoveryRequest,
  ): Promise<LocalModelDiscoveryResult> {
    return await this.local.discoverLocalModels(input);
  }

  registerLocalModel(
    input: LocalModelRegistrationRequest,
  ): LocalModelRegistrationResult {
    return this.local.registerLocalModel(input);
  }

  updateLocalModel(
    modelRef: string,
    input: LocalModelUpdateRequest,
  ): LocalModelRegistrationResult {
    return this.local.updateLocalModel(modelRef, input);
  }

  deleteLocalModel(modelRef: string): LocalModelDeletionResult {
    return this.local.deleteLocalModel(modelRef);
  }
}
