import { useEffect, useRef, useState, type RefObject } from "react";
import { api } from "@/app/api.ts";
import {
  firstRunCopy,
  type FirstRunLanguage,
} from "@/app/firstRunSetup.ts";
import { useButlerStore } from "@/app/store.ts";
import type { AppModelSummary, SettingsView } from "@/app/types.ts";

type FirstRunCopy = (typeof firstRunCopy)[FirstRunLanguage];

interface UseFirstRunAddedModelDefaultOptions {
  copy: FirstRunCopy;
  enabled: boolean;
  initialRegisteredModelRefs: RefObject<Set<string> | null>;
  language: FirstRunLanguage;
  resetKey: number;
  loading: boolean;
  modelLoadFailed: boolean;
  registeredRuntimeModels: AppModelSummary[];
  runtimeModelRefs: string[];
  settingsDraft: SettingsView | null;
  setModelSaveStatus: (status: string) => void;
  setSettingsDraft: (settings: SettingsView) => void;
}

export function useFirstRunAddedModelDefault({
  copy,
  enabled,
  initialRegisteredModelRefs,
  language,
  resetKey,
  loading,
  modelLoadFailed,
  registeredRuntimeModels,
  runtimeModelRefs,
  settingsDraft,
  setModelSaveStatus,
  setSettingsDraft,
}: UseFirstRunAddedModelDefaultOptions) {
  const [addedDefaultModelRef, setAddedDefaultModelRef] = useState("");
  const autoSavingModelRef = useRef("");
  const addedDefaultSaved =
    Boolean(addedDefaultModelRef) &&
    settingsDraft?.model === addedDefaultModelRef &&
    runtimeModelRefs.includes(addedDefaultModelRef);

  useEffect(() => {
    setAddedDefaultModelRef("");
    autoSavingModelRef.current = "";
  }, [resetKey]);

  useEffect(() => {
    const initialRefs = initialRegisteredModelRefs.current;
    const addedModel = initialRefs
      ? registeredRuntimeModels.find(
          (model) => !initialRefs.has(model.model_ref),
        )
      : null;
    if (
      !enabled ||
      loading ||
      modelLoadFailed ||
      !settingsDraft ||
      !addedModel ||
      addedDefaultSaved ||
      autoSavingModelRef.current === addedModel.model_ref
    ) {
      return undefined;
    }

    let cancelled = false;
    const baseSettings = settingsDraft;
    autoSavingModelRef.current = addedModel.model_ref;
    async function saveAddedDefaultModel(targetModel: AppModelSummary) {
      setModelSaveStatus(copy.modelSaving);
      const fallbackSettings: SettingsView = {
        ...baseSettings,
        language,
        model: targetModel.model_ref,
        reasoning_effort: targetModel.default_reasoning_effort,
        context_window_tokens: targetModel.context_window_tokens,
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
        const nextSettings = {
          ...fallbackSettings,
          ...result,
          language,
        } as SettingsView;
        useButlerStore.getState().setSettings(nextSettings);
        setSettingsDraft(nextSettings);
        setAddedDefaultModelRef(targetModel.model_ref);
        setModelSaveStatus("");
      } catch {
        if (!cancelled) {
          setAddedDefaultModelRef(targetModel.model_ref);
          setModelSaveStatus(copy.modelSaveFailed);
        }
      } finally {
        if (!cancelled) autoSavingModelRef.current = "";
      }
    }

    void saveAddedDefaultModel(addedModel);
    return () => {
      cancelled = true;
    };
  }, [
    addedDefaultSaved,
    copy.modelSaveFailed,
    copy.modelSaving,
    enabled,
    initialRegisteredModelRefs,
    language,
    loading,
    modelLoadFailed,
    registeredRuntimeModels,
    setModelSaveStatus,
    setSettingsDraft,
    settingsDraft,
  ]);

  return { addedDefaultSaved };
}
