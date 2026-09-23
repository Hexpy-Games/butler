import { useState, useEffect } from "react";
import type {
  AppModelSummary,
  LocalModelDiscoveryRequest,
  LocalModelDiscoveryResult,
} from "@/app/types.ts";

const DEFAULT_PLATFORM = "custom" as const;
type LocalModelPlatform = LocalModelDiscoveryRequest["platform"];

export function useLocalModelState() {
  const [platform, setPlatform] = useState<LocalModelPlatform>(DEFAULT_PLATFORM);
  const [apiKey, setApiKey] = useState<string | undefined>(undefined);
  const [serverUrl, setServerUrl] = useState("");
  const [discovery, setDiscovery] = useState<LocalModelDiscoveryResult | null>(null);
  const [selectedModelRef, setSelectedModelRef] = useState("");
  const [manualModelId, setManualModelId] = useState("");
  const [manualDisplayName, setManualDisplayName] = useState("");
  const [manualContext, setManualContext] = useState("16384");
  const [editingModelRef, setEditingModelRef] = useState("");
  const [busy, setBusy] = useState<"discover" | "register" | "delete" | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!discovery?.models.length) return;
    setSelectedModelRef((current) => current || discovery.models[0]!.model_ref);
  }, [discovery]);

  const selectedModel =
    discovery?.models.find((model) => model.model_ref === selectedModelRef) ?? null;
  const isEditing = editingModelRef.length > 0;
  const canDiscover = serverUrl.trim().length > 0 && !busy;
  const canRegister =
    !busy &&
    serverUrl.trim().length > 0 &&
    manualModelId.trim().length > 0 &&
    Number(manualContext) > 0;

  function editModel(model: AppModelSummary) {
    setEditingModelRef(model.model_ref);
    setApiKey(undefined);
    setDiscovery(null);
    setSelectedModelRef("");
    setPlatform(model.platform ?? DEFAULT_PLATFORM);
    setServerUrl(model.api_base_url ?? model.server_url ?? "");
    setManualModelId(model.model_id);
    setManualDisplayName(model.display_name);
    setManualContext(String(model.context_window_tokens));
    setStatus("");
  }

  return {
    apiKey,
    setApiKey,
    platform,
    setPlatform,
    serverUrl,
    setServerUrl,
    discovery,
    setDiscovery,
    selectedModelRef,
    setSelectedModelRef,
    manualModelId,
    setManualModelId,
    manualDisplayName,
    setManualDisplayName,
    manualContext,
    setManualContext,
    editingModelRef,
    setEditingModelRef,
    busy,
    setBusy,
    status,
    setStatus,
    selectedModel,
    isEditing,
    canDiscover,
    canRegister,
    editModel,
  };
}
