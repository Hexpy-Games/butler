import { useEffect, useMemo, useState } from "react";
import { Stack } from "@/butler-ds";
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
    busy,
    setBusy,
    status,
    setStatus,
    selectedModel,
    isEditing,
    canDiscover,
    canRegister,
    editModel,
  } = state;

  useEffect(() => {
    if (initialEditModel) editModel(initialEditModel);
  }, [initialEditModel?.model_ref]);

  const { hasUnsavedChanges, clearLeaveGuard } = useLocalModelUnsavedGuard({
    initialEditModel,
    isEditing,
    platform,
    serverUrl,
    modelId: manualModelId,
    displayName: manualDisplayName,
    context: manualContext,
  });

  const { discover, register, deleteModel } = useLocalModelOperations({
    platform,
    serverUrl,
    manualModelId,
    manualDisplayName,
    manualContext,
    preservedReasoningBudgetRatio: initialEditModel?.local_reasoning_budget_ratio,
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
    setBusy,
    setStatus,
    onCatalogChange: setModelCatalog,
    onSaved: () => {
      clearLeaveGuard();
      back();
    },
  });

  function chooseDiscoveredModel(modelRef: string) {
    setSelectedModelRef(modelRef);
    const model = discovery?.models.find((item) => item.model_ref === modelRef);
    if (!model) return;
    setManualModelId(model.model_id);
    setManualDisplayName(model.display_name);
    setManualContext(String(model.context_window_tokens));
  }

  const showModelInfo = isEditing || Boolean(discovery);

  return (
    <Stack gap="md">
      <LocalModelApiSection
        platform={platform}
        setPlatform={setPlatform}
        serverUrl={serverUrl}
        setServerUrl={setServerUrl}
        advancedOpen={advancedOpen}
        setAdvancedOpen={setAdvancedOpen}
        canDiscover={canDiscover}
        discovering={busy === "discover"}
        onDiscover={discover}
      />

      {showModelInfo ? (
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
          status={status}
          hasUnsavedChanges={hasUnsavedChanges}
          canRegister={canRegister}
          registering={busy === "register"}
          isEditing={isEditing}
          onRegister={register}
        />
      ) : null}

      {!hideRegisteredList && registeredLocalModels.length > 0 && (
        <LocalModelRegisteredList
          models={registeredLocalModels}
          busy={Boolean(busy)}
          editingModelRef={editingModelRef}
          onEdit={editModel}
          onDelete={deleteModel}
        />
      )}
    </Stack>
  );
}
