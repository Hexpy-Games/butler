import { HostedCredentialFields } from "./HostedCredentialFields";
import type { OpenAIOAuthLoginResult } from "./modelManagementApi";
import type { ModelCatalogView, ProviderAuthMethod } from "@/app/types.ts";

interface HostedCredentialSectionProps {
  apiKey: string;
  authMethod: ProviderAuthMethod;
  authMethods: ProviderAuthMethod[];
  credentialId: string;
  credentialLabel: string;
  modelCatalog: ModelCatalogView;
  oauthBusy?: boolean;
  oauthCallbackUrl?: string;
  oauthLogin?: OpenAIOAuthLoginResult | null;
  providerId: string;
  onApiKeyChange: (value: string) => void;
  onAuthMethodChange: (value: ProviderAuthMethod) => void;
  onCredentialIdChange: (value: string) => void;
  onCredentialLabelChange: (value: string) => void;
  onOAuthCallbackUrlChange?: (value: string) => void;
  onOAuthCheck?: () => void;
  onOAuthCopyUrl?: () => void;
  onOAuthOpenUrl?: () => void;
  onOAuthRestart?: () => void;
  onOAuthSubmitCallback?: () => void;
}

export function HostedCredentialSection({
  apiKey,
  authMethod,
  authMethods,
  credentialId,
  credentialLabel,
  modelCatalog,
  oauthBusy,
  oauthCallbackUrl,
  oauthLogin,
  providerId,
  onApiKeyChange,
  onAuthMethodChange,
  onCredentialIdChange,
  onCredentialLabelChange,
  onOAuthCallbackUrlChange,
  onOAuthCheck,
  onOAuthCopyUrl,
  onOAuthOpenUrl,
  onOAuthRestart,
  onOAuthSubmitCallback,
}: HostedCredentialSectionProps) {
  if (authMethods.length === 0) return null;

  return (
    <HostedCredentialFields
      modelCatalog={modelCatalog}
      providerId={providerId}
      authMethod={authMethod}
      credentialId={credentialId}
      apiKey={apiKey}
      credentialLabel={credentialLabel}
      oauthBusy={oauthBusy}
      oauthCallbackUrl={oauthCallbackUrl}
      oauthLogin={oauthLogin}
      authMethods={authMethods}
      onAuthMethodChange={onAuthMethodChange}
      onCredentialIdChange={onCredentialIdChange}
      onApiKeyChange={onApiKeyChange}
      onCredentialLabelChange={onCredentialLabelChange}
      onOAuthCallbackUrlChange={onOAuthCallbackUrlChange}
      onOAuthCheck={onOAuthCheck}
      onOAuthCopyUrl={onOAuthCopyUrl}
      onOAuthOpenUrl={onOAuthOpenUrl}
      onOAuthRestart={onOAuthRestart}
      onOAuthSubmitCallback={onOAuthSubmitCallback}
    />
  );
}
