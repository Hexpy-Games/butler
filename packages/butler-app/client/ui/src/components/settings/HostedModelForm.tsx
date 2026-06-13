import { Stack } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { SettingsSection } from "./SettingsFormComponents";
import { HostedCredentialSection } from "./HostedCredentialSection";
import { HostedModelSelectFields } from "./HostedModelSelectFields";
import { HostedModelSaveButton } from "./HostedModelSaveButton";
import { useHostedModelForm } from "./useHostedModelForm";
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
  const form = useHostedModelForm({
    allowedAuthMethods,
    editingModel,
    providerId: controlledProviderId,
    onProviderIdChange,
  });
  const copy = appCopy.settings.modelManagement;

  return (
    <SettingsSection title={editingModel ? copy.editTitle : copy.addTitle}>
      <Stack gap="md">
        <HostedModelSelectFields
          modelOptions={form.providerModelOptions}
          modelRef={form.modelRef}
          providerId={form.providerId}
          providers={form.providers}
          showProviderSelect={showProviderSelect}
          onModelRefChange={form.setModelRef}
          onProviderIdChange={form.setProviderId}
        />
        <HostedCredentialSection
          modelCatalog={form.modelCatalog}
          providerId={form.providerId}
          authMethod={form.authMethod}
          credentialId={form.credentialId}
          apiKey={form.apiKey}
          credentialLabel={form.credentialLabel}
          authMethods={form.authMethods}
          oauthBusy={form.oauthBusy}
          oauthLogin={form.oauthLogin}
          onAuthMethodChange={form.setAuthMethod}
          onCredentialIdChange={form.setCredentialId}
          onApiKeyChange={form.setApiKey}
          onCredentialLabelChange={form.setCredentialLabel}
          onOAuthCheck={() => void form.handleOAuthCheck()}
          onOAuthCopyUrl={() => {
            if (form.oauthLogin?.auth_url) {
              void navigator.clipboard?.writeText(form.oauthLogin.auth_url);
            }
          }}
          onOAuthOpenUrl={() => {
            if (form.oauthLogin?.auth_url) {
              window.open(form.oauthLogin.auth_url, "_blank", "noopener");
            }
          }}
          onOAuthRestart={() => void form.handleOAuthRestart()}
        />
        <HostedModelSaveButton
          busy={form.busy}
          disabled={!form.canSave}
          label={editingModel ? copy.saveEdit : copy.saveAdd}
          savingLabel={copy.saving}
          onClick={() => void form.save()}
        />
      </Stack>
    </SettingsSection>
  );
}
