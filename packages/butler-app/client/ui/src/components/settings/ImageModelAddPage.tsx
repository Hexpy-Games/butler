import { useState } from "react";
import { api } from "@/app/api";
import { appCopy, useAppLocale } from "@/app/copy";
import { notifyError, notifyStatus } from "@/app/notifications";
import { useButlerStore } from "@/app/store";
import type { ModelCatalogView } from "@/app/types";
import { ButtonContainer, SettingsSection } from "@/butler-ds";
import { useSettingsUIStore } from "@/stores/settingsUIStore";
import type { ImageModel, ImageSettings } from "../images/imageApi";
import { useImageSettingsState } from "../images/imageSettingsState";
import { CustomImageModelForm } from "./CustomImageModelForm";
import { HostedCredentialFields } from "./HostedCredentialFields";
import { HostedModelSelectFields } from "./HostedModelSelectFields";
import { HostedModelSaveButton } from "./HostedModelSaveButton";
import { imageModelSummary } from "./ImageModelManagementPage";
import { ModelRouteFrame } from "./ModelRouteFrame";
import { NEW_CREDENTIAL_ID } from "./modelManagementUtils";
import { ProviderMark } from "./ProviderMark";
import { SettingsPage, SettingsSelect } from "./SettingsFormComponents";

export function ImageModelAddPage() {
  useAppLocale();
  const settings = useImageSettingsState(s => s.settings);
  const back = useSettingsUIStore(s => s.backModelRoute);
  const copy = appCopy.settings.modelManagement;
  const providers = [...new Map((settings?.models ?? []).filter(m => m.provider_id !== "custom-image").map(m => [m.provider_id, m])).values()];
  const [providerId, setProviderId] = useState(providers[0]?.provider_id ?? "custom-image");
  const saved = (settings: ImageSettings) => {
    useImageSettingsState.setState({ settings });
    void back();
  };
  return <ModelRouteFrame title={copy.addTitle}><SettingsPage>
    <SettingsSection id="image-model-provider" kind="form" title={appCopy.settings.pageSections.modelProvider}>
      <SettingsSelect settingId="image-model-provider" triggerTestClass="image-model-add-provider-select" label={copy.provider} value={providerId} onChange={setProviderId}
        options={[...providers.map(m => ({ value: m.provider_id, label: m.provider_label, icon: <ProviderMark providerId={m.provider_id} besideProviderName /> })),
          { value: "custom-image", label: appCopy.conversation.imageTools.custom }]} />
    </SettingsSection>
    <SettingsSection id="image-model-add" kind="form" title={copy.model}>
      {providerId === "custom-image" ? <CustomImageModelForm onCancel={() => void back()} onSaved={saved} /> :
        <HostedImageModelForm key={providerId} providerId={providerId} models={(settings?.models ?? []).filter(m => m.provider_id === providerId && !settings?.registered.includes(m.model_ref))} onSaved={saved} />}
    </SettingsSection>
  </SettingsPage></ModelRouteFrame>;
}

function HostedImageModelForm({ providerId, models, onSaved }: {
  providerId: string; models: ImageModel[]; onSaved: (settings: ImageSettings) => void;
}) {
  const catalog = useButlerStore(s => s.modelCatalog);
  const setCatalog = useButlerStore(s => s.setModelCatalog);
  const [modelRef, setModelRef] = useState(models[0]?.model_ref ?? "");
  const [credentialId, setCredentialId] = useState(catalog.provider_credentials?.find(c => c.provider_id === providerId && c.auth_type === "api_key")?.id ?? NEW_CREDENTIAL_ID);
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const copy = appCopy.settings.modelManagement;
  const save = async () => {
    setBusy(true);
    try {
      let id = credentialId;
      if (id === NEW_CREDENTIAL_ID) {
        const result = await api<{ credential: { id: string }; catalog: ModelCatalogView }>("/model-catalog/provider-credentials", { method: "POST",
          body: JSON.stringify({ provider_id: providerId, auth_type: "api_key", api_key: apiKey, label }) });
        setCatalog(result.catalog); id = result.credential.id; setCredentialId(id); setApiKey("");
      }
      const settings = await api<ImageSettings>("/settings/image-model/registered", { method: "POST", body: JSON.stringify({ model_ref: modelRef, credential_id: id }) });
      notifyStatus(copy.registeredStatus(models.find(m => m.model_ref === modelRef)!.display_name), { tone: "ok" });
      onSaved(settings);
    } catch (error) { notifyError(error, appCopy.settings.errors.saveFailed); }
    finally { setBusy(false); }
  };
  return <>
    <HostedModelSelectFields modelOptions={models.map(imageModelSummary)} modelRef={modelRef} providerId={providerId} providers={catalog.providers}
      showProviderSelect={false} showTokenCaption={false} onModelRefChange={setModelRef} onProviderIdChange={() => {}} />
    <HostedCredentialFields modelCatalog={{ ...catalog, provider_credentials: catalog.provider_credentials?.filter(c => c.auth_type === "api_key") }} providerId={providerId}
      authMethod="api_key" authMethods={["api_key"]} credentialId={credentialId} apiBaseUrl="" apiKey={apiKey} credentialLabel={label}
      onApiBaseUrlChange={() => {}} onAuthMethodChange={() => {}} onCredentialIdChange={setCredentialId} onApiKeyChange={setApiKey} onCredentialLabelChange={setLabel} />
    <ButtonContainer size="default" justify="end"><HostedModelSaveButton busy={busy} disabled={!modelRef || (credentialId === NEW_CREDENTIAL_ID && !apiKey.trim())}
      label={copy.saveAdd} savingLabel={copy.saving} onClick={() => void save()} /></ButtonContainer>
  </>;
}
