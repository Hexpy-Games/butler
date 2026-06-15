import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import {
  firstRunCopy,
  type FirstRunLanguage,
} from "@/app/firstRunSetup.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ModelCatalogView, SettingsView } from "@/app/types.ts";
import { runtimeModels } from "@/app/utils.ts";
import { registeredModels } from "@/components/settings/modelManagementUtils";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { useFirstRunAddedModelDefault } from "./useFirstRunAddedModelDefault";

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
  const [modelSettingsLoaded, setModelSettingsLoaded] = useState(false);
  const completedRef = useRef(false);
  const initialRegisteredModelRefs = useRef<Set<string> | null>(null);
  const registeredRuntimeModels = useMemo(
    () => registeredModels(modelCatalog).filter((model) => model.runtime_supported),
    [modelCatalog],
  );
  const registeredRuntimeModelRefs = useMemo(
    () => registeredRuntimeModels.map((model) => model.model_ref),
    [registeredRuntimeModels],
  );
  const registeredDefaultSaved =
    Boolean(settingsDraft?.model) &&
    registeredRuntimeModelRefs.includes(settingsDraft?.model ?? "");
  const { onRetryDefaultModelSave } = useFirstRunAddedModelDefault({
    copy,
    enabled,
    initialRegisteredModelRefs,
    language,
    loading,
    modelLoadFailed,
    registeredDefaultSaved,
    registeredRuntimeModels,
    resetKey: loadAttempt,
    setModelSaveStatus,
    setSettingsDraft,
    settingsDraft,
  });

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    async function loadModelSettings() {
      setLoading(true);
      setModelSaveStatus(copy.modelLoading);
      setModelLoadFailed(false);
      setModelSettingsLoaded(false);
      completedRef.current = false;
      try {
        const [settings, catalog] = await Promise.all([
          api<SettingsView>("/settings"),
          api<ModelCatalogView>("/model-catalog"),
        ]);
        if (cancelled) return;
        let persistedLanguageSettings: Partial<SettingsView> = {};
        if (settings.language !== language) {
          try {
            persistedLanguageSettings = await api<Partial<SettingsView>>("/settings", {
              method: "PATCH",
              body: JSON.stringify({ language }),
            });
          } catch {
            if (!cancelled) {
              setModelLoadFailed(true);
              setModelSaveStatus(copy.modelSaveFailed);
            }
            return;
          }
        }
        if (cancelled) return;
        const localizedSettings = {
          ...settings,
          ...persistedLanguageSettings,
          language,
        };
        useButlerStore.getState().setSettings(localizedSettings);
        useButlerStore.getState().setModelCatalog(catalog);
        initialRegisteredModelRefs.current = new Set(
          registeredModels(catalog).map((model) => model.model_ref),
        );
        useSettingsUIStore.setState({
          activeSection: "models",
          draft: localizedSettings,
          localMessage: null,
          modelRoute: { page: "add" },
          modelRouteDirection: "forward",
          modelRouteLeaveGuard: null,
        });
        setModelSettingsLoaded(true);
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
  }, [
    copy.modelLoadFailed,
    copy.modelLoading,
    copy.modelSaveFailed,
    enabled,
    language,
    loadAttempt,
  ]);

  const modelSettingsReady =
    enabled && !loading && !modelLoadFailed && modelSettingsLoaded;
  const modelSetupReady =
    modelSettingsReady && availableModelCount > 0 && registeredDefaultSaved;

  useEffect(() => {
    if (!modelSetupReady || completedRef.current) return;
    completedRef.current = true;
    onComplete();
  }, [modelSetupReady, onComplete]);

  return {
    modelLoadFailed,
    modelSaveStatus,
    modelSettingsReady,
    modelSetupReady,
    onRetryModelLoad: () => setLoadAttempt((current) => current + 1),
    onRetryModelSave: onRetryDefaultModelSave,
  };
}
