import { useEffect, useMemo, useState } from "react";
import { Stack } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { modelDisplayName } from "@/app/utils.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsSection } from "./SettingsFormComponents";
import { HostedCredentialSection } from "./HostedCredentialSection";
import { HostedModelSelectFields } from "./HostedModelSelectFields";
import { HostedModelSaveButton } from "./HostedModelSaveButton";
import {
  registerHostedModel,
  startOpenAIOAuthLogin,
} from "./modelManagementApi";
import {
  NEW_CREDENTIAL_ID,
  hostedModelProviders,
  providerAllowedAuthMethods,
  providerCredentials,
  providerModels,
} from "./modelManagementUtils";
import type { AppModelSummary, ProviderAuthMethod } from "@/app/types.ts";

interface HostedModelFormProps {
  allowedAuthMethods?: ProviderAuthMethod[];
  editingModel?: AppModelSummary | null;
  providerId?: string;
  onProviderIdChange?: (providerId: string) => void;
  showProviderSelect?: boolean;
}

export function HostedModelForm({
  allowedAuthMethods,
  editingModel,
  providerId: controlledProviderId,
  onProviderIdChange,
  showProviderSelect = true,
}: HostedModelFormProps) {
  const modelCatalog = useButlerStore((state) => state.modelCatalog);
  const setModelCatalog = useButlerStore((state) => state.setModelCatalog);
  const back = useSettingsUIStore((state) => state.backModelRoute);
  const copy = appCopy.settings.modelManagement;
  const providers = hostedModelProviders(modelCatalog, allowedAuthMethods);
  const [internalProviderId, setInternalProviderId] = useState(
    editingModel?.provider_id ?? providers[0]?.provider_id ?? "openai",
  );
  const providerId = controlledProviderId ?? internalProviderId;
  const setProviderId = onProviderIdChange ?? setInternalProviderId;
  const providerModelOptions = useMemo(() => providerModels(modelCatalog, providerId), [modelCatalog, providerId]);
  const [modelRef, setModelRef] = useState(editingModel?.model_ref ?? "");
  const authMethods = providerAllowedAuthMethods(
    modelCatalog,
    providerId,
    allowedAuthMethods,
  );
  const [authMethod, setAuthMethod] = useState<ProviderAuthMethod>(
    editingModel?.auth_type ?? authMethods[0] ?? "api_key",
  );
  const credentials = providerCredentials(modelCatalog, providerId);
  const [credentialId, setCredentialId] = useState(
    editingModel?.credential_id ?? credentials[0]?.id ?? NEW_CREDENTIAL_ID,
  );
  const [apiKey, setApiKey] = useState("");
  const [credentialLabel, setCredentialLabel] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setModelRef((current) =>
      providerModelOptions.some((model) => model.model_ref === current)
        ? current
        : (providerModelOptions[0]?.model_ref ?? ""),
    );
    setAuthMethod((current) =>
      authMethods.includes(current) ? current : authMethods[0] ?? "api_key",
    );
    setCredentialId((current) =>
      credentials.some((credential) => credential.id === current)
        ? current
        : (credentials[0]?.id ?? NEW_CREDENTIAL_ID),
    );
  }, [providerId, providerModelOptions, authMethods, credentials]);

  const selectedModel = providerModelOptions.find((model) => model.model_ref === modelRef);
  const canSave = Boolean(selectedModel) &&
    authMethods.includes(authMethod) &&
    (authMethod !== "api_key" ||
      credentialId !== NEW_CREDENTIAL_ID ||
      apiKey.trim().length > 0);

  async function save() {
    if (!selectedModel || !canSave) return;
    setBusy(true);
    try {
      if (authMethod === "codex_oauth") {
        await startOpenAIOAuthLogin();
      }
      const result = await registerHostedModel({
        provider_id: providerId,
        model_id: selectedModel.model_id,
        auth_type: authMethod,
        ...(authMethod === "api_key" && credentialId !== NEW_CREDENTIAL_ID
          ? { credential_id: credentialId }
          : {}),
        ...(authMethod === "api_key" && credentialId === NEW_CREDENTIAL_ID
          ? { api_key: apiKey, credential_label: credentialLabel }
          : {}),
      });
      setModelCatalog(result.catalog);
      notifyStatus(copy.registeredStatus(modelDisplayName(result.model)), {
        id: "hosted-model-save",
        tone: "ok",
      });
      back();
    } catch (error) {
      notifyError(error, copy.errors.save, { id: "hosted-model-save" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection title={editingModel ? copy.editTitle : copy.addTitle}>
      <Stack gap="md">
        <HostedModelSelectFields
          modelOptions={providerModelOptions}
          modelRef={modelRef}
          providerId={providerId}
          providers={providers}
          showProviderSelect={showProviderSelect}
          onModelRefChange={setModelRef}
          onProviderIdChange={setProviderId}
        />
        <HostedCredentialSection
          modelCatalog={modelCatalog}
          providerId={providerId}
          authMethod={authMethod}
          credentialId={credentialId}
          apiKey={apiKey}
          credentialLabel={credentialLabel}
          authMethods={authMethods}
          onAuthMethodChange={setAuthMethod}
          onCredentialIdChange={setCredentialId}
          onApiKeyChange={setApiKey}
          onCredentialLabelChange={setCredentialLabel}
        />
        <HostedModelSaveButton
          busy={busy}
          disabled={!canSave}
          label={editingModel ? copy.saveEdit : copy.saveAdd}
          savingLabel={copy.saving}
          onClick={() => void save()}
        />
      </Stack>
    </SettingsSection>
  );
}
