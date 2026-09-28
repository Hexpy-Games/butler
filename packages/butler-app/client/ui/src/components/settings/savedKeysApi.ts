import { api } from "@/app/api.ts";
import type {
  CredentialDeletionResult,
  CredentialListView,
  ModelCatalogView,
  ProviderCredentialView,
} from "@/app/types.ts";

// #217 saved API keys, served by the agent (PR #290).

export async function listSavedKeys(): Promise<CredentialListView> {
  const result = await api<CredentialListView>("/credentials");
  return { ...result, credentials: Array.isArray(result?.credentials) ? result.credentials : [] };
}

/** Replaces the key; the provider checks it first (`verify`), so a rejected key changes nothing. */
export async function replaceSavedKey(id: string, apiKey: string): Promise<ProviderCredentialView> {
  const result = await api<{ credential: ProviderCredentialView }>(`/credentials/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ api_key: apiKey, verify: true }),
  });
  return result.credential;
}

/** `force` also removes the models that use the key (never the default model's key). */
export async function deleteSavedKey(id: string, force: boolean): Promise<CredentialDeletionResult> {
  return await api<CredentialDeletionResult>(
    `/credentials/${encodeURIComponent(id)}${force ? "?force=true" : ""}`,
    { method: "DELETE" },
  );
}

export async function fetchModelCatalog(): Promise<ModelCatalogView> {
  return await api<ModelCatalogView>("/model-catalog");
}
