import {
  DEFAULT_MODEL_REF,
  localModelConfigToMetadata,
  type ModelCatalogView,
  type ProviderModelMetadata,
} from "../../../../integrations/providers/model-catalog.ts";
import {
  deleteLocalModelConfig,
  discoverLocalModels,
  readLocalModelConfigs,
  updateLocalModelConfig,
  upsertLocalModelConfig,
} from "../../../../integrations/providers/local-models.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import type {
  LocalModelDeletionResult,
  LocalModelDiscoveryRequest,
  LocalModelDiscoveryResult,
  LocalModelRegistrationRequest,
  LocalModelRegistrationResult,
  LocalModelUpdateRequest,
} from "../../interface/protocol/app-protocol.ts";
import type { AppModelSettingsPolicy } from "./model-settings-policy.ts";

export class AppLocalModelRegistryStore {
  constructor(
    private readonly butlerData: string,
    private readonly policy: AppModelSettingsPolicy,
    private readonly appendEvent: (
      type: string,
      payload: Record<string, unknown>,
    ) => void,
    private readonly getModelCatalog: () => ModelCatalogView,
  ) {}

  metadata(): ProviderModelMetadata[] {
    return readLocalModelConfigs(this.butlerData).map(
      localModelConfigToMetadata,
    );
  }

  async discoverLocalModels(
    input: LocalModelDiscoveryRequest,
  ): Promise<LocalModelDiscoveryResult> {
    let result;
    try {
      result = await discoverLocalModels({
        serverUrl: input.server_url,
        apiType: input.api_type,
        platform: input.platform,
      });
    } catch (error) {
      throw new AppStoreOperationError(
        502,
        "local_model_discovery_failed",
        error instanceof Error
          ? error.message
          : "Local model discovery failed.",
      );
    }
    return {
      server_url: result.server_url,
      api_base_url: result.api_base_url,
      api_type: result.api_type,
      platform: result.platform,
      models: result.models.map((model) =>
        localModelConfigToMetadata({
          ...model,
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
        }),
      ),
    };
  }

  registerLocalModel(
    input: LocalModelRegistrationRequest,
  ): LocalModelRegistrationResult {
    let model;
    try {
      model = upsertLocalModelConfig(
        {
          serverUrl: input.server_url,
          apiType: input.api_type,
          platform: input.platform,
          modelId: input.model_id,
          displayName: input.display_name,
          contextWindowTokens: input.context_window_tokens,
          maxOutputTokens: input.max_output_tokens,
          reasoningBudgetRatio: input.reasoning_budget_ratio,
          source: input.source,
        },
        this.butlerData,
      );
    } catch (error) {
      throw new AppStoreOperationError(
        400,
        "local_model_registration_failed",
        error instanceof Error
          ? error.message
          : "Local model registration failed.",
      );
    }
    const summary = localModelConfigToMetadata(model);
    this.appendEvent("settings.local_model_registered", {
      model_ref: summary.model_ref,
      provider_id: summary.provider_id,
      api_type: summary.api_type,
      platform: summary.platform,
      context_window_tokens: summary.context_window_tokens,
      reasoning_budget_ratio: summary.local_reasoning_budget_ratio ?? 0,
    });
    return {
      model: summary,
      catalog: this.getModelCatalog(),
    };
  }

  updateLocalModel(
    modelRef: string,
    input: LocalModelUpdateRequest,
  ): LocalModelRegistrationResult {
    let result;
    try {
      result = updateLocalModelConfig(
        modelRef,
        {
          serverUrl: input.server_url,
          apiType: input.api_type,
          platform: input.platform,
          modelId: input.model_id,
          displayName: input.display_name,
          contextWindowTokens: input.context_window_tokens,
          maxOutputTokens: input.max_output_tokens,
          reasoningBudgetRatio: input.reasoning_budget_ratio,
          source: input.source,
        },
        this.butlerData,
      );
    } catch (error) {
      throw new AppStoreOperationError(
        error instanceof Error && error.message.includes("not registered")
          ? 404
          : 400,
        "local_model_update_failed",
        error instanceof Error ? error.message : "Local model update failed.",
      );
    }
    const summary = localModelConfigToMetadata(result.model);
    if (result.previousModelRef !== summary.model_ref) {
      this.policy.rewriteStoredModelRefs(
        result.previousModelRef,
        summary.model_ref,
      );
    }
    this.policy.normalizeStoredModelSettings();
    this.appendEvent("settings.local_model_updated", {
      previous_model_ref: result.previousModelRef,
      model_ref: summary.model_ref,
      provider_id: summary.provider_id,
      api_type: summary.api_type,
      platform: summary.platform,
      context_window_tokens: summary.context_window_tokens,
      reasoning_budget_ratio: summary.local_reasoning_budget_ratio ?? 0,
    });
    return {
      model: summary,
      catalog: this.getModelCatalog(),
    };
  }

  deleteLocalModel(modelRef: string): LocalModelDeletionResult {
    const targetModelRef = this.resolveRegisteredLocalModelRef(modelRef);
    if (!targetModelRef) {
      throw new AppStoreOperationError(
        404,
        "local_model_delete_failed",
        "Local model is not registered.",
      );
    }
    if (this.policy.hasActiveTurnUsingModel(targetModelRef)) {
      throw new AppStoreOperationError(
        409,
        "local_model_in_use",
        "This local model is currently used by an active turn. Try again after the turn finishes.",
      );
    }
    let removed;
    try {
      removed = deleteLocalModelConfig(modelRef, this.butlerData);
    } catch (error) {
      throw new AppStoreOperationError(
        error instanceof Error && error.message.includes("not registered")
          ? 404
          : 400,
        "local_model_delete_failed",
        error instanceof Error ? error.message : "Local model deletion failed.",
      );
    }
    this.policy.rewriteStoredModelRefs(removed.model_ref, DEFAULT_MODEL_REF);
    this.policy.normalizeStoredModelSettings();
    this.appendEvent("settings.local_model_deleted", {
      removed_model_ref: removed.model_ref,
      provider_id: removed.provider_id,
    });
    return {
      removed_model_ref: removed.model_ref,
      catalog: this.getModelCatalog(),
    };
  }

  private resolveRegisteredLocalModelRef(modelRef: string): string | null {
    const trimmed = modelRef.trim();
    const asRef = trimmed.startsWith("local/") ? trimmed : `local/${trimmed}`;
    const model = this.metadata().find(
      (candidate) =>
        candidate.model_ref === asRef ||
        candidate.model_id === trimmed ||
        candidate.model_ref === trimmed,
    );
    return model?.model_ref ?? null;
  }
}
