import { modelDisplayName, tokenWindowLabel } from "@/app/utils.ts";
import type {
  AppModelSummary,
  ModelCatalogView,
  ProviderAuthMethod,
  ProviderCredentialView,
} from "@/app/types.ts";

export const LOCAL_PROVIDER_ID = "local";
export const NEW_CREDENTIAL_ID = "__new";

export function modelOptionLabel(model: AppModelSummary): string {
  return `${modelDisplayName(model)} (${tokenWindowLabel(model.context_window_tokens)})`;
}

export function registeredModels(modelCatalog: ModelCatalogView): AppModelSummary[] {
  return modelCatalog.registered_models ?? [];
}

export function providerAuthMethods(
  modelCatalog: ModelCatalogView,
  providerId: string,
): ProviderAuthMethod[] {
  const provider = modelCatalog.providers.find((item) => item.provider_id === providerId);
  return provider?.auth_methods?.length ? provider.auth_methods : ["api_key"];
}

export function providerCredentials(
  modelCatalog: ModelCatalogView,
  providerId: string,
): ProviderCredentialView[] {
  return (modelCatalog.provider_credentials ?? []).filter(
    (credential) => credential.provider_id === providerId,
  );
}

export function providerModels(
  modelCatalog: ModelCatalogView,
  providerId: string,
): AppModelSummary[] {
  const provider = modelCatalog.providers.find(
    (item) => item.provider_id === providerId,
  );
  const sourceModels = provider?.models?.length
    ? provider.models
    : modelCatalog.models;
  return sourceModels.filter(
    (model) => model.provider_id === providerId && model.runtime_supported,
  );
}
