import { useEffect, useMemo, useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { modelDisplayName } from "@/app/utils.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import {
  getOpenAIOAuthLoginStatus,
  registerHostedModel,
  restartOpenAIOAuthLogin,
  startOpenAIOAuthLogin,
  type OpenAIOAuthLoginResult,
} from "./modelManagementApi";
import {
  NEW_CREDENTIAL_ID,
  hostedModelProviders,
  providerAllowedAuthMethods,
  providerCredentials,
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
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthRegistering, setOauthRegistering] = useState(false);
  const [oauthLogin, setOauthLogin] = useState<OpenAIOAuthLoginResult | null>(null);
  const oauthAutoStartKeyRef = useRef<string | null>(null);
  const oauthPollingRef = useRef(false);
  const oauthRegisteringRef = useRef(false);

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
  const oauthSaveBlocked = authMethod === "codex_oauth" &&
    (oauthBusy || oauthRegistering);
  const canSave = Boolean(selectedModel) &&
    authMethods.includes(authMethod) &&
    !oauthSaveBlocked &&
    (authMethod !== "api_key" ||
      credentialId !== NEW_CREDENTIAL_ID ||
      apiKey.trim().length > 0);
  const oauthReady = oauthLogin?.status === "completed" ||
    oauthLogin?.status === "profile_exists";
  const oauthSessionActive = oauthReady ||
    oauthLogin?.status === "pending" ||
    oauthLogin?.status === "starting";

  useEffect(() => {
    if (authMethod !== "codex_oauth" || editingModel) {
      oauthAutoStartKeyRef.current = null;
      return;
    }
    if (oauthBusy || oauthSessionActive) return;
    const key = `${providerId}:${modelRef || "default"}`;
    if (oauthAutoStartKeyRef.current === key) return;
    oauthAutoStartKeyRef.current = key;
    void startOAuthSession();
  }, [authMethod, editingModel, modelRef, oauthBusy, oauthSessionActive, providerId]);

  useEffect(() => {
    if (
      authMethod !== "codex_oauth" ||
      (oauthLogin?.status !== "pending" && oauthLogin?.status !== "starting") ||
      oauthBusy ||
      oauthRegistering
    ) return;
    let cancelled = false;
    const poll = () => {
      if (oauthPollingRef.current || oauthRegisteringRef.current) return;
      oauthPollingRef.current = true;
      void checkOAuthCompletion({ silent: true, cancelled: () => cancelled })
        .finally(() => {
          oauthPollingRef.current = false;
        });
    };
    const timer = window.setInterval(poll, 1000);
    poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [authMethod, oauthBusy, oauthLogin?.status, oauthRegistering]);

  async function save() {
    if (
      !selectedModel ||
      !canSave ||
      oauthSaveBlocked ||
      oauthRegisteringRef.current
    ) return;
    setBusy(true);
    try {
      if (authMethod === "codex_oauth" && !oauthReady) {
        const login = await startOAuthSession();
        if (login.status === "completed" || login.status === "profile_exists") {
          await registerCurrentModel();
        }
        return;
      }
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
    });
    setModelCatalog(result.catalog);
    notifyStatus(copy.registeredStatus(modelDisplayName(result.model)), {
      id: "hosted-model-save",
      tone: "ok",
    });
    back();
  }

  async function handleOAuthCheck() {
    await withOAuthBusy(async () => {
      await checkOAuthCompletion();
    });
  }

  async function handleOAuthRestart() {
    await startOAuthSession(true);
  }

  async function withOAuthBusy(action: () => Promise<void>) {
    setOauthBusy(true);
    try {
      await action();
    } catch (error) {
      notifyError(error, copy.errors.oauthLogin, { id: "hosted-model-oauth" });
    } finally {
      setOauthBusy(false);
    }
  }

  async function checkOAuthCompletion(input?: {
    cancelled?: () => boolean;
    silent?: boolean;
  }) {
    let status: OpenAIOAuthLoginResult;
    try {
      status = await getOpenAIOAuthLoginStatus();
    } catch (error) {
      if (!input?.silent) {
        notifyError(error, copy.errors.oauthLogin, { id: "hosted-model-oauth" });
      }
      return;
    }
    if (input?.cancelled?.()) return;
    setOauthLogin(status);
    if (
      (status.status === "completed" || status.status === "profile_exists") &&
      !oauthRegisteringRef.current
    ) {
      oauthRegisteringRef.current = true;
      setOauthRegistering(true);
      try {
        await registerCurrentModel();
      } catch (error) {
        oauthRegisteringRef.current = false;
        setOauthRegistering(false);
        notifyError(error, copy.errors.save, { id: "hosted-model-save" });
      }
    }
  }

  async function startOAuthSession(force = false) {
    let result: OpenAIOAuthLoginResult | null = null;
    await withOAuthBusy(async () => {
      result = force
        ? await restartOpenAIOAuthLogin()
        : await startOpenAIOAuthLogin();
      setOauthLogin(result);
    });
    if (!result) {
      result = { status: "failed", error: copy.errors.oauthLogin };
      setOauthLogin(result);
    }
    return result;
  }

  return {
    apiKey,
    authMethod,
    authMethods,
    busy: busy || oauthRegistering,
    canSave,
    copy,
    credentialId,
    credentialLabel,
    modelCatalog,
    modelRef,
    oauthBusy,
    oauthLogin,
    providerId,
    providerModelOptions,
    providers,
    setApiKey,
    setAuthMethod,
    setCredentialId,
    setCredentialLabel,
    setModelRef,
    setProviderId,
    handleOAuthCheck,
    handleOAuthRestart,
    save,
  };
}
