import type { AppCopy } from "@/app/copy.ts";
import type { CredentialStorage, ModelCatalogView, SavedCredentialView } from "@/app/types.ts";

type StorageLabels = AppCopy["settings"]["savedKeys"]["storage"];

/**
 * Where the key is kept, as the agent reports it (#217). The owner-only file
 * and keys not migrated yet both stay on this computer; only the system
 * stores are named (Keychain, Secret Service, Credential Manager).
 */
export function credentialStorageLabel(storage: CredentialStorage | undefined, labels: StorageLabels): string {
  if (storage === "keychain") return labels.keychain;
  if (storage === "secret_service") return labels.secretService;
  if (storage === "credential_manager") return labels.credentialManager;
  return labels.local;
}

export type CredentialDeleteRule =
  | { kind: "blocked" }
  | { kind: "force"; count: number }
  | { kind: "plain" };

/** `openai/gpt-5`, or a bare id the agent namespaces itself (`gpt-5`). */
function matchesRef(modelRef: string, candidate: string): boolean {
  const value = candidate.trim();
  if (!value) return false;
  return value.includes("/") ? modelRef === value : modelRef.slice(modelRef.indexOf("/") + 1) === value;
}

/**
 * The agent's delete rule (`DELETE /credentials/{name}`): the default model's
 * key is never deleted; a key other models use is deleted with `force`, which
 * removes those models too; an unused key is deleted plainly.
 */
export function credentialDeleteRule(credential: SavedCredentialView, defaultModelRefs: readonly string[]): CredentialDeleteRule {
  const refs = credential.model_refs ?? [];
  if (refs.some((ref) => defaultModelRefs.some((candidate) => matchesRef(ref, candidate)))) return { kind: "blocked" };
  return refs.length > 0 ? { kind: "force", count: refs.length } : { kind: "plain" };
}

/** The saved main model and the catalog's configured default. */
export function defaultModelRefs(settingsModel: string | undefined, catalog: ModelCatalogView): string[] {
  return [settingsModel ?? "", catalog.default_model_ref ?? ""];
}

/** "OpenAI", or "OpenAI / work" when the key has its own name. */
export function credentialDisplayName(credential: SavedCredentialView, catalog: ModelCatalogView): string {
  const provider = catalog.providers.find((item) => item.provider_id === credential.provider_id)?.provider_label
    ?? credential.provider_id;
  return credential.label && credential.label !== credential.provider_id ? `${provider} / ${credential.label}` : provider;
}
