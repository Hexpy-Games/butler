import { signOutChatGpt } from "../chatgpt/chatGptActions";
import { useAppLocale } from "@/app/copy.ts";
import { ButtonContainer, Stack, Tooltip } from "@/butler-ds";
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
  useAppLocale();
  const form = useHostedModelForm({
    allowedAuthMethods,
    editingModel,
    providerId: controlledProviderId,
    onProviderIdChange,
  });
  const copy = appCopy.settings.modelManagement;

  return (
    <SettingsSection id="hosted-model" kind="form" title={editingModel ? copy.editTitle : copy.addTitle}>
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
          chatgpt={{ signIn: form.signIn, account: form.chatgpt.account, editing: Boolean(editingModel), onSignOut: () => void signOutChatGpt().then(account => { form.signIn.leave(); form.chatgpt.setAccount(account); }) }}
          apiBaseUrl={form.apiBaseUrl}
          showApiBaseUrl={form.showApiBaseUrl}
          onAuthMethodChange={form.setAuthMethod}
          onCredentialIdChange={form.setCredentialId}
          onApiKeyChange={form.setApiKey}
          onApiBaseUrlChange={form.setApiBaseUrl}
          onCredentialLabelChange={form.setCredentialLabel}

        />
        <ButtonContainer size="default" justify="end">
        <Tooltip label={form.authMethod === "chatgpt_oauth" && !form.oauthReady ? appCopy.chatgptSignIn.addHint : ""}>
        <HostedModelSaveButton
          busy={form.busy}
          disabled={!form.canSave}
          label={editingModel ? copy.saveEdit : copy.saveAdd}
          savingLabel={copy.saving}
          onClick={() => void form.save()}
        />
        </Tooltip>
        </ButtonContainer>
      </Stack>
    </SettingsSection>
  );
}
