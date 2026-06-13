import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import {
  firstRunCopy,
  type FirstRunLanguage,
} from "@/app/firstRunSetup.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ModelCatalogView, SettingsView } from "@/app/types.ts";
import { runtimeModels } from "@/app/utils.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";

type FirstRunCopy = (typeof firstRunCopy)[FirstRunLanguage];

interface UseFirstRunModelSetupOptions {
  copy: FirstRunCopy;
  enabled: boolean;
  language: FirstRunLanguage;
  onComplete: () => void;
}

export function useFirstRunModelSetup({
  copy,
  enabled,
  language,
  onComplete,
}: UseFirstRunModelSetupOptions) {
  const availableModelCount = useButlerStore(
    (state) => runtimeModels(state.modelCatalog).length,
  );
  const modelCatalog = useButlerStore((state) => state.modelCatalog);
  const settingsDraft = useSettingsUIStore((state) => state.draft);
  const setSettingsDraft = useSettingsUIStore((state) => state.setDraft);
  const [modelSaveStatus, setModelSaveStatus] = useState("");
  const [modelLoadFailed, setModelLoadFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const autoSavingModelRef = useRef("");
  const runtimeModelRefs = useMemo(
    () => runtimeModels(modelCatalog).map((model) => model.model_ref),
    [modelCatalog],
  );
  const defaultModelSaved =
    settingsDraft?.model
      ? runtimeModelRefs.includes(settingsDraft.model)
      : false;

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    async function loadModelSettings() {
      setLoading(true);
      setModelSaveStatus(copy.modelLoading);
      setModelLoadFailed(false);
      try {
        const [settings, catalog] = await Promise.all([
          api<SettingsView>("/settings"),
          api<ModelCatalogView>("/model-catalog"),
        ]);
        if (cancelled) return;
        const localizedSettings = { ...settings, language };
        useButlerStore.getState().setSettings(localizedSettings);
        useButlerStore.getState().setModelCatalog(catalog);
        useSettingsUIStore.setState({
          activeSection: "models",
          draft: localizedSettings,
          localMessage: null,
          modelRoute: { page: "root" },
          modelRouteDirection: "back",
          modelRouteLeaveGuard: null,
        });
        const supportedModels = runtimeModels(catalog);
        if (supportedModels.length === 0) {
          throw new Error("model_catalog_empty");
        }
        setModelSaveStatus("");
      } catch {
        if (cancelled) return;
        setModelLoadFailed(true);
        setModelSaveStatus(copy.modelLoadFailed);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadModelSettings();
    return () => {
      cancelled = true;
    };
  }, [copy.modelLoadFailed, copy.modelLoading, enabled, language, loadAttempt]);

  useEffect(() => {
    if (
      !enabled ||
      loading ||
      modelLoadFailed ||
      !settingsDraft ||
      runtimeModelRefs.length === 0 ||
      defaultModelSaved
    ) {
      return undefined;
    }
    const targetModel = runtimeModels(modelCatalog)[0];
    if (!targetModel || autoSavingModelRef.current === targetModel.model_ref) {
      return undefined;
    }
    let cancelled = false;
    autoSavingModelRef.current = targetModel.model_ref;
    async function saveAvailableDefaultModel() {
      setModelSaveStatus(copy.modelSaving);
      const fallbackSettings: SettingsView = {
        ...settingsDraft!,
        language,
        model: targetModel!.model_ref,
        reasoning_effort: targetModel!.default_reasoning_effort,
        context_window_tokens: targetModel!.context_window_tokens,
      };
      try {
        const result = await api<Partial<SettingsView>>("/settings", {
          method: "PATCH",
          body: JSON.stringify({
            model: fallbackSettings.model,
            reasoning_effort: fallbackSettings.reasoning_effort,
            context_window_tokens: fallbackSettings.context_window_tokens,
          }),
        });
        if (cancelled) return;
        const nextSettings = { ...fallbackSettings, ...result, language };
        useButlerStore.getState().setSettings(nextSettings);
        setSettingsDraft(nextSettings);
        setModelSaveStatus("");
      } catch {
        if (cancelled) return;
        setModelLoadFailed(true);
        setModelSaveStatus(copy.modelSaveFailed);
      } finally {
        if (!cancelled) autoSavingModelRef.current = "";
      }
    }
    void saveAvailableDefaultModel();
    return () => {
      cancelled = true;
    };
  }, [
    copy.modelSaveFailed,
    copy.modelSaving,
    defaultModelSaved,
    enabled,
    language,
    loading,
    modelCatalog,
    modelLoadFailed,
    runtimeModelRefs,
    setSettingsDraft,
    settingsDraft,
  ]);

  const modelSetupReady =
    enabled &&
    !loading &&
    !modelLoadFailed &&
    availableModelCount > 0 &&
    Boolean(settingsDraft) &&
    defaultModelSaved;

  return {
    modelLoadFailed,
    modelSaveStatus,
    modelSetupReady,
    onRetryModelLoad: () => setLoadAttempt((current) => current + 1),
    onSaveModel: () => {
      if (modelSetupReady) onComplete();
    },
  };
}
