import { useState, useEffect } from "react";
import type {
  AppModelSummary,
  LocalModelDiscoveryRequest,
  LocalModelDiscoveryResult,
} from "@/app/types.ts";
import { imageInputChange, responseTimeoutMs, responseTimeoutSeconds } from "../localModelApi";

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
  const [responseTimeout, setResponseTimeout] = useState("");
  const [editingModelRef, setEditingModelRef] = useState("");
  const [busy, setBusy] = useState<"discover" | "register" | "delete" | null>(null);
  const [status, setStatus] = useState("");
  // The switch starts at the model's effective support (off for a manual entry); a choice is kept only once made.
  const [imageInputInitial, setImageInputInitial] = useState(false);
  const [imageInputChoice, setImageInputChoice] = useState<boolean>();

  useEffect(() => {
    if (!discovery?.models.length) return;
    setSelectedModelRef((current) => current || discovery.models[0]!.model_ref);
  }, [discovery]);

  const selectedModel =
    discovery?.models.find((model) => model.model_ref === selectedModelRef) ?? null;
  const isEditing = editingModelRef.length > 0;
  const responseTimeoutInvalid = Number.isNaN(responseTimeoutMs(responseTimeout));
  const canDiscover = serverUrl.trim().length > 0 && !busy;
  const canRegister =
    !busy &&
    serverUrl.trim().length > 0 &&
    manualModelId.trim().length > 0 &&
    Number(manualContext) > 0 &&
    !responseTimeoutInvalid;
  const imageInput = {
    checked: imageInputChoice ?? imageInputInitial,
    change: imageInputChange(imageInputInitial, imageInputChoice),
    setChecked: setImageInputChoice,
  };

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
    setResponseTimeout(responseTimeoutSeconds(model.response_timeout_ms));
    setImageInputInitial(model.image_input_support === "supported");
    setImageInputChoice(undefined);
    setStatus("");
  }

  // A new registration starts the switch at what discovery found; an edit keeps the registered model's value.
  function seedImageInput(model: AppModelSummary | null) {
    if (editingModelRef) return;
    setImageInputInitial(model?.image_input_support === "supported");
    setImageInputChoice(undefined);
  }

  function chooseDiscoveredModel(modelRef: string) {
    setSelectedModelRef(modelRef);
    const model = discovery?.models.find((item) => item.model_ref === modelRef);
    if (!model) return;
    setManualModelId(model.model_id);
    setManualDisplayName(model.display_name);
    setManualContext(String(model.context_window_tokens));
    seedImageInput(model);
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
    responseTimeout,
    setResponseTimeout,
    responseTimeoutInvalid,
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
    imageInput,
    seedImageInput,
    chooseDiscoveredModel,
  };
}
