import { useState } from "react";
import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import { notifyError } from "@/app/notifications";
import { useButlerStore } from "@/app/store";
import type { ModelCatalogView } from "@/app/types.ts";
import { Button, ButtonContainer } from "@/butler-ds";
import { HostedCredentialFields } from "./HostedCredentialFields";
import { NEW_CREDENTIAL_ID } from "./modelManagementUtils";

/** Reuses the hosted model key fields, restricted to API-key authentication. */
export function ImageCredentialForm({ providerId, credentialId, disabled, onSelect }: {
  providerId: string; credentialId: string | null; disabled: boolean; onSelect: (id: string) => Promise<void>;
}) {
  const modelCatalog = useButlerStore(s => s.modelCatalog);
  const setModelCatalog = useButlerStore(s => s.setModelCatalog);
  const [adding, setAdding] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const copy = appCopy.settings.modelManagement;
  const value = adding || !credentialId ? NEW_CREDENTIAL_ID : credentialId;
  const add = async () => {
    setBusy(true);
    try {
      const result = await api<{ credential: { id: string }; catalog: ModelCatalogView }>("/model-catalog/provider-credentials", { method: "POST",
        body: JSON.stringify({ provider_id: providerId, auth_type: "api_key", api_key: apiKey, label }) });
      setModelCatalog(result.catalog);
      setApiKey(""); setLabel(""); setAdding(false);
      await onSelect(result.credential.id);
    } catch (error) { notifyError(error, appCopy.settings.errors.saveFailed); }
    finally { setBusy(false); }
  };
  return <>
    <HostedCredentialFields modelCatalog={modelCatalog} providerId={providerId} authMethod="api_key" authMethods={["api_key"]}
      credentialId={value} apiBaseUrl="" apiKey={apiKey} credentialLabel={label}
      onApiBaseUrlChange={() => {}} onAuthMethodChange={() => {}}
      onCredentialIdChange={id => { setAdding(id === NEW_CREDENTIAL_ID); if (id !== NEW_CREDENTIAL_ID) void onSelect(id); }}
      onApiKeyChange={setApiKey} onCredentialLabelChange={setLabel} />
    {value === NEW_CREDENTIAL_ID && <ButtonContainer size="default" justify="end">
      <Button type="button" disabled={busy || disabled || !apiKey.trim()} onClick={() => void add()}>{busy ? copy.saving : copy.saveAdd}</Button>
    </ButtonContainer>}
  </>;
}
