import { Input, SettingsField, Stack } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { ModelCatalogView, ProviderAuthMethod } from "@/app/types.ts";
import type { OpenAIOAuthLoginResult } from "./modelManagementApi";
import { HostedOAuthFields } from "./HostedOAuthFields";
import { SettingsSelect } from "./SettingsFormComponents";
import {
  NEW_CREDENTIAL_ID,
  providerCredentials,
} from "./modelManagementUtils";

interface HostedCredentialFieldsProps {
  modelCatalog: ModelCatalogView;
  providerId: string;
  authMethod: ProviderAuthMethod;
  credentialId: string;
  apiKey: string;
  credentialLabel: string;
  oauthBusy?: boolean;
  oauthCallbackUrl?: string;
  oauthLogin?: OpenAIOAuthLoginResult | null;
  onAuthMethodChange: (value: ProviderAuthMethod) => void;
  onCredentialIdChange: (value: string) => void;
  onOAuthCallbackUrlChange?: (value: string) => void;
  onOAuthCheck?: () => void;
  onOAuthCopyUrl?: () => void;
  onOAuthOpenUrl?: () => void;
  onOAuthRestart?: () => void;
  onOAuthSubmitCallback?: () => void;
  onApiKeyChange: (value: string) => void;
  onCredentialLabelChange: (value: string) => void;
  authMethods: ProviderAuthMethod[];
}

export function HostedCredentialFields({
  modelCatalog,
  providerId,
  authMethod,
  credentialId,
  apiKey,
  credentialLabel,
  oauthBusy = false,
  oauthCallbackUrl = "",
  oauthLogin = null,
  onAuthMethodChange,
  onCredentialIdChange,
  onOAuthCallbackUrlChange,
  onOAuthCheck,
  onOAuthCopyUrl,
  onOAuthOpenUrl,
  onOAuthRestart,
  onOAuthSubmitCallback,
  onApiKeyChange,
  onCredentialLabelChange,
  authMethods,
}: HostedCredentialFieldsProps) {
  const copy = appCopy.settings.modelManagement;
  const credentials = providerCredentials(modelCatalog, providerId);
  const selectedCredential = credentials.find((item) => item.id === credentialId);
  const showAuthSelect = authMethods.length > 1;
  const showNewKey = authMethod === "api_key" &&
    (credentialId === NEW_CREDENTIAL_ID || credentials.length === 0);

  return (
    <Stack gap="md">
      {showAuthSelect ? (
        <SettingsSelect
          label={copy.authMethod}
          triggerTestClass="hosted-auth-method-select"
          value={authMethod}
          onChange={(value) => onAuthMethodChange(value as ProviderAuthMethod)}
          options={authMethods.map((method) => ({
            value: method,
            label: method === "codex_oauth" ? copy.codexOauth : copy.apiKeyAuth,
          }))}
        />
      ) : null}
      {authMethod === "api_key" ? (
        <>
          <SettingsSelect
            label={copy.credential}
            triggerTestClass="hosted-credential-select"
            value={credentialId || NEW_CREDENTIAL_ID}
            onChange={onCredentialIdChange}
            options={[
              ...credentials.map((credential) => ({
                value: credential.id,
                label: `${credential.label} (${credential.masked_value})`,
              })),
              { value: NEW_CREDENTIAL_ID, label: copy.newCredential },
            ]}
          />
          {selectedCredential && !showNewKey ? (
            <SettingsField
              label={copy.apiKey}
              control={<Input value={selectedCredential.masked_value} disabled />}
            />
          ) : null}
          {showNewKey ? (
            <>
              <SettingsField
                label={copy.credentialLabel}
                control={<Input value={credentialLabel} onChange={(event) => onCredentialLabelChange(event.target.value)} />}
              />
              <SettingsField
                label={copy.apiKey}
                control={<Input value={apiKey} onChange={(event) => onApiKeyChange(event.target.value)} type="password" />}
              />
            </>
          ) : null}
        </>
      ) : null}
      {authMethod === "codex_oauth" ? (
        <HostedOAuthFields
          callbackUrl={oauthCallbackUrl}
          login={oauthLogin}
          busy={oauthBusy}
          onCallbackUrlChange={onOAuthCallbackUrlChange ?? (() => {})}
          onCheck={onOAuthCheck ?? (() => {})}
          onCopyUrl={onOAuthCopyUrl ?? (() => {})}
          onOpenUrl={onOAuthOpenUrl ?? (() => {})}
          onRestart={onOAuthRestart ?? (() => {})}
          onSubmitCallback={onOAuthSubmitCallback ?? (() => {})}
        />
      ) : null}
    </Stack>
  );
}
