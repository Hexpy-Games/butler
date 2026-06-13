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
  oauthLogin?: OpenAIOAuthLoginResult | null;
  providerId: string;
  onApiKeyChange: (value: string) => void;
  onAuthMethodChange: (value: ProviderAuthMethod) => void;
  onCredentialIdChange: (value: string) => void;
  onCredentialLabelChange: (value: string) => void;
  onOAuthCheck?: () => void;
  onOAuthCopyUrl?: () => void;
  onOAuthOpenUrl?: () => void;
  onOAuthRestart?: () => void;
}

export function HostedCredentialSection({
  apiKey,
  authMethod,
  authMethods,
  credentialId,
  credentialLabel,
  modelCatalog,
  oauthBusy,
  oauthLogin,
  providerId,
  onApiKeyChange,
  onAuthMethodChange,
  onCredentialIdChange,
  onCredentialLabelChange,
  onOAuthCheck,
  onOAuthCopyUrl,
  onOAuthOpenUrl,
  onOAuthRestart,
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
      oauthLogin={oauthLogin}
      authMethods={authMethods}
      onAuthMethodChange={onAuthMethodChange}
      onCredentialIdChange={onCredentialIdChange}
      onApiKeyChange={onApiKeyChange}
      onCredentialLabelChange={onCredentialLabelChange}
      onOAuthCheck={onOAuthCheck}
      onOAuthCopyUrl={onOAuthCopyUrl}
      onOAuthOpenUrl={onOAuthOpenUrl}
      onOAuthRestart={onOAuthRestart}
    />
  );
}
