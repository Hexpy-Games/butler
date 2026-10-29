import { useState } from "react";
import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import { notifyError } from "@/app/notifications";
import { useButlerStore } from "@/app/store";
import { Button, SettingsField } from "@/butler-ds";
import { HostedCredentialFields } from "./HostedCredentialFields";
import { NEW_CREDENTIAL_ID } from "./modelManagementUtils";

/** Reuses the hosted model key fields, restricted to API-key authentication. */
export function ImageCredentialForm({ providerId, onSaved }: { providerId: string; onSaved: (id: string) => Promise<void> }) {
  const modelCatalog = useButlerStore(s => s.modelCatalog);
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const copy = appCopy.settings.modelManagement;
  const save = async () => {
    setBusy(true);
    try {
      const result = await api<{ credential: { id: string } }>("/credentials", { method: "POST",
        body: JSON.stringify({ provider_id: providerId, api_key: apiKey, label }) });
      setApiKey("");
      await onSaved(result.credential.id);
    } catch (error) { notifyError(error, appCopy.settings.errors.saveFailed); }
    finally { setBusy(false); }
  };
  return <>
    <HostedCredentialFields modelCatalog={modelCatalog} providerId={providerId} authMethod="api_key" authMethods={["api_key"]}
      credentialId={NEW_CREDENTIAL_ID} apiBaseUrl="" apiKey={apiKey} credentialLabel={label}
      onApiBaseUrlChange={() => {}} onAuthMethodChange={() => {}} onCredentialIdChange={() => {}}
      onApiKeyChange={setApiKey} onCredentialLabelChange={setLabel} />
    <SettingsField id="image-key-save" label={copy.apiKey} control={<Button disabled={busy || !apiKey.trim()}
      onClick={() => void save()}>{busy ? copy.saving : copy.saveAdd}</Button>} />
  </>;
}
