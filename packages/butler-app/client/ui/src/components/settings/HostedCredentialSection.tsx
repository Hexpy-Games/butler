import { HostedCredentialFields } from "./HostedCredentialFields";
import type { ModelCatalogView, ProviderAuthMethod } from "@/app/types.ts";

interface HostedCredentialSectionProps {
  apiKey: string;
  authMethod: ProviderAuthMethod;
  authMethods: ProviderAuthMethod[];
  credentialId: string;
  credentialLabel: string;
  modelCatalog: ModelCatalogView;
  providerId: string;
  onApiKeyChange: (value: string) => void;
  onAuthMethodChange: (value: ProviderAuthMethod) => void;
  onCredentialIdChange: (value: string) => void;
  onCredentialLabelChange: (value: string) => void;
}

export function HostedCredentialSection({
  apiKey,
  authMethod,
  authMethods,
  credentialId,
  credentialLabel,
  modelCatalog,
  providerId,
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
      credentialLabel={credentialLabel}
      authMethods={authMethods}
      onAuthMethodChange={onAuthMethodChange}
      onCredentialIdChange={onCredentialIdChange}
      onApiKeyChange={onApiKeyChange}
      onCredentialLabelChange={onCredentialLabelChange}
    />
  );
}
