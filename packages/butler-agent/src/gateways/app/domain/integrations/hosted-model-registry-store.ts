import {
  DEFAULT_MODEL_REF,
  type ModelCatalogView,
  type ProviderModelMetadata,
} from "../../../../integrations/providers/model-catalog.ts";
import {
  credentialView,
  deleteHostedModelConfig,
  listProviderCredentialViews,
  registerHostedModelConfig,
  registeredHostedModelMetadata,
  upsertProviderApiKeyCredential,
  type HostedModelProviderId,
} from "../../../../integrations/providers/registered-models.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import type {
  HostedModelDeletionResult,
  HostedModelRegistrationRequest,
  HostedModelRegistrationResult,
  ProviderCredentialMutationResult,
  ProviderCredentialUpsertRequest,
} from "../../interface/protocol/app-protocol.ts";
import type { AppModelSettingsPolicy } from "./model-settings-policy.ts";

export class AppHostedModelRegistryStore {
  constructor(
    private readonly butlerData: string,
    private readonly policy: AppModelSettingsPolicy,
    private readonly appendEvent: (
      type: string,
      payload: Record<string, unknown>,
    ) => void,
    private readonly getModelCatalog: () => ModelCatalogView,
    private readonly registeredModelMetadata: () => ProviderModelMetadata[],
  ) {}

  providerCredentialViews() {
    return listProviderCredentialViews(this.butlerData);
  }

  metadata(): ProviderModelMetadata[] {
    return registeredHostedModelMetadata(this.butlerData);
  }

  upsertProviderCredential(
    input: ProviderCredentialUpsertRequest,
  ): ProviderCredentialMutationResult {
    try {
      const credential = upsertProviderApiKeyCredential(
        {
          providerId: input.provider_id as HostedModelProviderId,
          apiKey: input.api_key,
          label: input.label,
          credentialId: input.credential_id,
        },
        this.butlerData,
      );
      const view = credentialView(credential);
      this.appendEvent("settings.provider_credential_saved", {
        provider_id: view.provider_id,
        auth_type: view.auth_type,
        credential_id: view.id,
        masked_value: view.masked_value,
      });
      return {
        credential: view,
        catalog: this.getModelCatalog(),
      };
    } catch (error) {
      throw new AppStoreOperationError(
        400,
        "provider_credential_save_failed",
        error instanceof Error
          ? error.message
          : "Provider credential save failed.",
      );
    }
  }

  registerHostedModel(
    input: HostedModelRegistrationRequest,
  ): HostedModelRegistrationResult {
    try {
      const config = registerHostedModelConfig(
        {
          providerId: input.provider_id as HostedModelProviderId,
          modelId: input.model_id,
          displayName: input.display_name,
          authType: input.auth_type,
          credentialId: input.credential_id,
          apiKey: input.api_key,
          credentialLabel: input.credential_label,
          apiBaseUrl: input.api_base_url,
        },
        this.butlerData,
      );
      const model = this.metadata().find(
        (candidate) => candidate.model_ref === config.model_ref,
      );
      if (!model) throw new Error("Registered model metadata was not found.");
      this.policy.normalizeStoredModelSettings();
      this.appendEvent("settings.hosted_model_registered", {
        model_ref: model.model_ref,
        provider_id: model.provider_id,
        auth_type: model.auth_type,
        credential_id: model.credential_id,
      });
      return {
        model,
        catalog: this.getModelCatalog(),
      };
    } catch (error) {
      throw new AppStoreOperationError(
        400,
        "hosted_model_registration_failed",
        error instanceof Error
          ? error.message
          : "Hosted model registration failed.",
      );
    }
  }

  deleteHostedModel(modelRef: string): HostedModelDeletionResult {
    const targetModelRef = this.resolveRegisteredHostedModelRef(modelRef);
    if (!targetModelRef) {
      throw new AppStoreOperationError(
        404,
        "hosted_model_delete_failed",
        "Hosted model is not registered.",
      );
    }
    if (this.policy.hasActiveTurnUsingModel(targetModelRef)) {
      throw new AppStoreOperationError(
        409,
        "hosted_model_in_use",
        "This hosted model is currently used by an active turn. Try again after the turn finishes.",
      );
    }
    let removed;
    try {
      removed = deleteHostedModelConfig(targetModelRef, this.butlerData);
    } catch (error) {
      throw new AppStoreOperationError(
        error instanceof Error && error.message.includes("not registered")
          ? 404
          : 400,
        "hosted_model_delete_failed",
        error instanceof Error
          ? error.message
          : "Hosted model deletion failed.",
      );
    }
    const fallbackModelRef =
      this.registeredModelMetadata().find((model) => model.runtime_supported)
        ?.model_ref ?? DEFAULT_MODEL_REF;
    this.policy.rewriteStoredModelRefs(removed.model_ref, fallbackModelRef);
    this.policy.normalizeStoredModelSettings();
    this.appendEvent("settings.hosted_model_deleted", {
      removed_model_ref: removed.model_ref,
      provider_id: removed.provider_id,
    });
    return {
      removed_model_ref: removed.model_ref,
      catalog: this.getModelCatalog(),
    };
  }

  private resolveRegisteredHostedModelRef(modelRef: string): string | null {
    const trimmed = modelRef.trim();
    const model = this.metadata().find(
      (candidate) =>
        candidate.model_ref === trimmed || candidate.model_id === trimmed,
    );
    return model?.model_ref ?? null;
  }
}
