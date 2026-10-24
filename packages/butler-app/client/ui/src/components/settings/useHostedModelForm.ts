import { useChatGptAccount } from "../chatgpt/useChatGptAccount";
import { useSignIn } from "../first-run/useSignIn";
import { useEffect, useMemo, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { modelDisplayName } from "@/app/utils.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import {
  registerHostedModel,
} from "./modelManagementApi";
import {
  NEW_CREDENTIAL_ID,
  hostedModelProviders,
  providerAllowedAuthMethods,
  providerCredentials,
  providerDefaultApiBaseUrl,
  providerModels,
} from "./modelManagementUtils";
import type { AppModelSummary, ProviderAuthMethod } from "@/app/types.ts";

interface HostedModelFormStateInput {
  allowedAuthMethods?: ProviderAuthMethod[];
  editingModel?: AppModelSummary | null;
  providerId?: string;
  onProviderIdChange?: (providerId: string) => void;
}

export function useHostedModelForm({
  allowedAuthMethods,
  editingModel,
  providerId: controlledProviderId,
  onProviderIdChange,
}: HostedModelFormStateInput) {
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
  const providerModelOptions = useMemo(
    () => providerModels(modelCatalog, providerId),
    [modelCatalog, providerId],
  );
  const defaultApiBaseUrl = providerDefaultApiBaseUrl(modelCatalog, providerId);
  const [modelRef, setModelRef] = useState(editingModel?.model_ref ?? "");
  const [apiBaseUrl, setApiBaseUrl] = useState(
    editingModel?.api_base_url ?? defaultApiBaseUrl,
  );
  const showApiBaseUrl = Boolean(defaultApiBaseUrl || editingModel?.api_base_url);
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
  const chatgpt = useChatGptAccount();
  const signIn = useSignIn({ onSignedIn: () => { void chatgpt.refresh(); } });
  const requestedKind = useSettingsUIStore(state => state.chatgptSignInKind);
  useEffect(() => {
    if (!requestedKind) return;
    useSettingsUIStore.setState({ chatgptSignInKind: undefined });
    setAuthMethod("chatgpt_oauth");
    void signIn.start({ kind: requestedKind });
  }, [requestedKind]);
  const oauthReady = signIn.phase === "idle" && (chatgpt.account ? chatgpt.account.status === "signed_in" : signIn.view?.status === "completed" || signIn.view?.status === "profile_exists");

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

  useEffect(() => {
    setApiBaseUrl(editingModel?.api_base_url ?? defaultApiBaseUrl);
  }, [defaultApiBaseUrl, editingModel?.api_base_url, providerId]);

  const selectedModel = providerModelOptions.find((model) => model.model_ref === modelRef);
  const canSave = Boolean(selectedModel) && authMethods.includes(authMethod)
    && (authMethod === "chatgpt_oauth" ? oauthReady : credentialId !== NEW_CREDENTIAL_ID || apiKey.trim().length > 0);
  async function save() {
    if (
      !selectedModel ||
      !canSave
    ) return;
    setBusy(true);
    try {
      await registerCurrentModel();
    } catch (error) {
      notifyError(error, copy.errors.save, { id: "hosted-model-save" });
    } finally {
      setBusy(false);
    }
  }

  async function registerCurrentModel() {
    if (!selectedModel) return;
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
      ...(apiBaseUrl.trim() && apiBaseUrl.trim() !== defaultApiBaseUrl
        ? { api_base_url: apiBaseUrl.trim() }
        : {}),
    });
    setModelCatalog(result.catalog);
    notifyStatus(copy.registeredStatus(modelDisplayName(result.model)), {
      id: "hosted-model-save",
      tone: "ok",
    });
    back();
  }

  return {
    apiKey,
    apiBaseUrl,
    authMethod,
    authMethods,
    busy,
    canSave,
    copy,
    credentialId,
    credentialLabel,
    modelCatalog,
    modelRef,
    signIn,
    chatgpt,
    oauthReady,
    providerId,
    providerModelOptions,
    providers,
    showApiBaseUrl,
    setApiKey,
    setApiBaseUrl,
    setAuthMethod,
    setCredentialId,
    setCredentialLabel,
    setModelRef,
    setProviderId,

    save,
  };
}
