import { useEffect, useRef, useState, type RefObject } from "react";
import { api } from "@/app/api.ts";
import {
  firstRunCopy,
  type FirstRunLanguage,
} from "@/app/firstRunSetup.ts";
import { useButlerStore } from "@/app/store.ts";
import type { AppModelSummary, SettingsView } from "@/app/types.ts";

type FirstRunCopy = (typeof firstRunCopy)[FirstRunLanguage];

function selectedModelWorkerRules(
  settings: SettingsView,
  targetModel: AppModelSummary,
): SettingsView["worker_model_rules"] {
  const rules = settings.worker_model_rules.length > 0
    ? settings.worker_model_rules
    : [
        {
          id: "deep_work",
          label: "Deep work",
          condition: "Research, feature development, architecture, review, and analysis",
          enabled: true,
        },
        {
          id: "routine_work",
          label: "Routine work",
          condition: "Simple coding, search, inspection, formatting, and tool calls",
          enabled: true,
        },
      ];
  return rules.map((rule) => {
    const preferredEffort = rule.id === "deep_work" ? "high" : "medium";
    return {
      ...rule,
      model: targetModel.model_ref,
      reasoning_effort: targetModel.reasoning_efforts.includes(preferredEffort)
        ? preferredEffort
        : targetModel.default_reasoning_effort,
    };
  });
}

interface UseFirstRunAddedModelDefaultOptions {
  copy: FirstRunCopy;
  enabled: boolean;
  initialRegisteredModelRefs: RefObject<Set<string> | null>;
  language: FirstRunLanguage;
  resetKey: number;
  loading: boolean;
  modelLoadFailed: boolean;
  registeredDefaultSaved: boolean;
  registeredRuntimeModels: AppModelSummary[];
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
  registeredDefaultSaved,
  registeredRuntimeModels,
  settingsDraft,
  setModelSaveStatus,
  setSettingsDraft,
}: UseFirstRunAddedModelDefaultOptions) {
  const [addedDefaultModelRef, setAddedDefaultModelRef] = useState("");
  const [saveAttempt, setSaveAttempt] = useState(0);
  const autoSavingModelRef = useRef("");
  const addedDefaultSaved =
    Boolean(addedDefaultModelRef) &&
    settingsDraft?.model === addedDefaultModelRef &&
    registeredDefaultSaved;

  useEffect(() => {
    setAddedDefaultModelRef("");
    setSaveAttempt(0);
    autoSavingModelRef.current = "";
  }, [resetKey]);

  useEffect(() => {
    const initialRefs = initialRegisteredModelRefs.current;
    const addedModel = initialRefs
      ? registeredRuntimeModels.find(
          (model) => !initialRefs.has(model.model_ref),
        )
      : null;
    const targetModel = addedModel ?? (
      registeredDefaultSaved ? null : registeredRuntimeModels[0]
    );
    if (
      !enabled ||
      loading ||
      modelLoadFailed ||
      !settingsDraft ||
      !targetModel ||
      registeredDefaultSaved ||
      addedDefaultSaved ||
      autoSavingModelRef.current === targetModel.model_ref
    ) {
      return undefined;
    }

    let cancelled = false;
    const baseSettings = settingsDraft;
    autoSavingModelRef.current = targetModel.model_ref;
    async function saveAddedDefaultModel(targetModel: AppModelSummary) {
      setModelSaveStatus(copy.modelSaving);
      const fallbackSettings: SettingsView = {
        ...baseSettings,
        language,
        model: targetModel.model_ref,
        reasoning_effort: targetModel.default_reasoning_effort,
        context_window_tokens: targetModel.context_window_tokens ?? baseSettings.context_window_tokens,
        worker_model_rules: selectedModelWorkerRules(baseSettings, targetModel),
      };
      try {
        const result = await api<Partial<SettingsView>>("/settings", {
          method: "PATCH",
          body: JSON.stringify({
            language,
            model: fallbackSettings.model,
            reasoning_effort: fallbackSettings.reasoning_effort,
            context_window_tokens: fallbackSettings.context_window_tokens,
            worker_model_rules: fallbackSettings.worker_model_rules,
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
          setModelSaveStatus(copy.modelSaveFailed);
        }
      } finally {
        if (!cancelled) autoSavingModelRef.current = "";
      }
    }

    void saveAddedDefaultModel(targetModel);
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
    registeredDefaultSaved,
    registeredRuntimeModels,
    saveAttempt,
    setModelSaveStatus,
    setSettingsDraft,
    settingsDraft,
  ]);

  return {
    addedDefaultSaved,
    onRetryDefaultModelSave: () => {
      autoSavingModelRef.current = "";
      setSaveAttempt((current) => current + 1);
    },
  };
}
