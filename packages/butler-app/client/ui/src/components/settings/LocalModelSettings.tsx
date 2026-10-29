import { useEffect, useMemo, useState } from "react";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { useLocalModelState } from "./hooks/useLocalModelState";
import { useLocalModelOperations } from "./hooks/useLocalModelOperations";
import { useLocalModelUnsavedGuard } from "./hooks/useLocalModelUnsavedGuard";
import { LocalModelApiSection } from "./LocalModelApiSection";
import { LocalModelInfoSection } from "./LocalModelInfoSection";
import { LocalModelRegisteredList } from "./LocalModelRegisteredList";
import type { AppModelSummary } from "@/app/types.ts";

interface LocalModelSettingsProps {
  initialEditModel?: AppModelSummary | null;
  hideRegisteredList?: boolean;
}

export function LocalModelSettings({
  initialEditModel = null,
  hideRegisteredList = false,
}: LocalModelSettingsProps = {}) {
  const modelCatalog = useButlerStore((state) => state.modelCatalog);
  const setModelCatalog = useButlerStore((state) => state.setModelCatalog);
  const back = useSettingsUIStore((state) => state.backModelRoute);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const registeredLocalModels = useMemo(
    () => modelCatalog.models.filter((model) => model.provider_id === "local"),
    [modelCatalog.models],
  );

  const state = useLocalModelState();
  const {
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
  } = state;

  useEffect(() => {
    if (initialEditModel) editModel(initialEditModel);
  }, [initialEditModel?.model_ref]);

  const { hasUnsavedChanges, clearLeaveGuard } = useLocalModelUnsavedGuard({
    initialEditModel,
    isEditing,
    apiKey,
    platform,
    serverUrl,
    modelId: manualModelId,
    displayName: manualDisplayName,
    context: manualContext,
    responseTimeout,
    imageInputChanged: imageInput.change !== undefined,
  });

  const { discover, register, deleteModel, discoveryError, clearDiscoveryError } = useLocalModelOperations({
    apiKey,
    platform,
    serverUrl,
    manualModelId,
    manualDisplayName,
    manualContext,
    responseTimeout,
    preservedReasoningBudgetRatio: initialEditModel?.local_reasoning_budget_ratio,
    imageInput: imageInput.change,
    editingModelRef,
    selectedModel,
    canDiscover,
    canRegister,
    isEditing,
    busy,
    setDiscovery,
    setSelectedModelRef,
    setManualModelId,
    setManualDisplayName,
    setManualContext,
    seedImageInput,
    setBusy,
    setStatus,
    onCatalogChange: setModelCatalog,
    onSaved: () => { clearLeaveGuard(); back(); },
  });

  return (
    <>
      <LocalModelApiSection
        apiKey={apiKey}
        setApiKey={setApiKey}
        platform={platform}
        setPlatform={setPlatform}
        serverUrl={serverUrl}
        error={discoveryError}
        setServerUrl={(value) => { clearDiscoveryError(); setServerUrl(value); }}
        advancedOpen={advancedOpen}
        setAdvancedOpen={setAdvancedOpen}
        canDiscover={canDiscover}
        discovering={busy === "discover"}
        onDiscover={discover}
      />

      <LocalModelInfoSection
        discovery={discovery}
        selectedModelRef={selectedModelRef}
        setSelectedModelRef={chooseDiscoveredModel}
        manualModelId={manualModelId}
        setManualModelId={setManualModelId}
        manualDisplayName={manualDisplayName}
        setManualDisplayName={setManualDisplayName}
        manualContext={manualContext}
        setManualContext={setManualContext}
        responseTimeout={{ value: responseTimeout, setValue: setResponseTimeout, invalid: responseTimeoutInvalid }}
        imageInput={imageInput}
        status={status}
        hasUnsavedChanges={hasUnsavedChanges}
        canRegister={canRegister}
        registering={busy === "register"}
        isEditing={isEditing}
        onRegister={register}
      />

      {!hideRegisteredList && registeredLocalModels.length > 0 && (
        <LocalModelRegisteredList
          models={registeredLocalModels}
          busy={Boolean(busy)}
          editingModelRef={editingModelRef}
          onEdit={editModel}
          onDelete={deleteModel}
        />
      )}
    </>
  );
}
