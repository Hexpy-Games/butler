import { HostedCredentialFields } from "./HostedCredentialFields";
import type { ComponentProps } from "react";
import { ChatGptSignInCard } from "../chatgpt/ChatGptSignInCard";
import type { ModelCatalogView, ProviderAuthMethod } from "@/app/types.ts";

interface HostedCredentialSectionProps {
  apiBaseUrl: string;
  apiKey: string;
  authMethod: ProviderAuthMethod;
  authMethods: ProviderAuthMethod[];
  credentialId: string;
  credentialLabel: string;
  modelCatalog: ModelCatalogView;
  chatgpt: ComponentProps<typeof ChatGptSignInCard>;
  providerId: string;
  showApiBaseUrl?: boolean;
  onApiBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onAuthMethodChange: (value: ProviderAuthMethod) => void;
  onCredentialIdChange: (value: string) => void;
  onCredentialLabelChange: (value: string) => void;
}

export function HostedCredentialSection({
  apiBaseUrl,
  apiKey,
  authMethod,
  authMethods,
  credentialId,
  credentialLabel,
  modelCatalog,
  chatgpt,
  providerId,
  showApiBaseUrl = false,
  onApiBaseUrlChange,
  onApiKeyChange,
  onAuthMethodChange,
  onCredentialIdChange,
  onCredentialLabelChange,
}: HostedCredentialSectionProps) {
  if (authMethods.length === 0) return null;

  return (
    <HostedCredentialFields
      modelCatalog={modelCatalog}
      providerId={providerId}
      authMethod={authMethod}
      credentialId={credentialId}
      apiKey={apiKey}
      apiBaseUrl={apiBaseUrl}
      credentialLabel={credentialLabel}
      chatgpt={chatgpt}
      showApiBaseUrl={showApiBaseUrl}
      authMethods={authMethods}
      onApiBaseUrlChange={onApiBaseUrlChange}
      onAuthMethodChange={onAuthMethodChange}
      onCredentialIdChange={onCredentialIdChange}
      onApiKeyChange={onApiKeyChange}
      onCredentialLabelChange={onCredentialLabelChange}
    />
  );
}
