import { useEffect, useMemo, useState } from "react";
import { api } from "@/app/api.ts";
import { firstRunCopy, type FirstRunLanguage } from "@/app/firstRunSetup.ts";
import type {
  AppModelSummary,
  ModelCatalogView,
  SettingsView,
} from "@/app/types.ts";
import {
  modelDisplayName,
  tokenWindowLabel,
} from "@/app/utils.ts";

type FirstRunCopy = (typeof firstRunCopy)[FirstRunLanguage];

export interface FirstRunModelOption {
  description: string;
  label: string;
  value: string;
}

interface UseFirstRunModelSetupOptions {
  copy: FirstRunCopy;
  enabled: boolean;
  onComplete: () => void;
}

export function useFirstRunModelSetup({
  copy,
  enabled,
  onComplete,
}: UseFirstRunModelSetupOptions) {
  const [modelOptions, setModelOptions] = useState<FirstRunModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelSaveStatus, setModelSaveStatus] = useState("");
  const [modelSaving, setModelSaving] = useState(false);
  const [modelLoadFailed, setModelLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    async function loadModels() {
      setModelSaveStatus(copy.modelLoading);
      setModelLoadFailed(false);
      try {
        const [catalog, settings] = await Promise.all([
          api<ModelCatalogView>("/model-catalog"),
          api<Partial<SettingsView>>("/settings").catch(() => ({})),
        ]);
        if (cancelled) return;
        const options = modelOptionsFromCatalog(catalog);
        if (options.length === 0) throw new Error("model_catalog_empty");
        setModelOptions(options);
        setSelectedModel(resolveSelectedModel(catalog, settings, options));
        setModelSaveStatus("");
      } catch {
        if (cancelled) return;
        setModelOptions([]);
        setSelectedModel("");
        setModelLoadFailed(true);
        setModelSaveStatus(copy.modelLoadFailed);
      }
    }
    void loadModels();
    return () => {
      cancelled = true;
    };
  }, [copy.modelLoadFailed, copy.modelLoading, enabled, loadAttempt]);

  const selectedDescription = useMemo(
    () =>
      modelOptions.find((option) => option.value === selectedModel)
        ?.description ?? "",
    [modelOptions, selectedModel],
  );

  async function saveModel() {
    if (!selectedModel || modelSaving || modelLoadFailed) return;
    setModelSaving(true);
    setModelSaveStatus(copy.modelSaving);
    try {
      await api("/settings", {
        method: "PATCH",
        body: JSON.stringify({ model: selectedModel }),
      });
      setModelSaveStatus(copy.modelSaved);
      onComplete();
    } catch {
      setModelSaveStatus(copy.modelSaveFailed);
    } finally {
      setModelSaving(false);
    }
  }

  return {
    modelOptions,
    modelLoadFailed,
    modelSaveStatus,
    modelSaving,
    selectedDescription,
    selectedModel,
    onModelChange: setSelectedModel,
    onRetryModelLoad: () => setLoadAttempt((current) => current + 1),
    onSaveModel: () => void saveModel(),
  };
}

function modelOptionsFromCatalog(
  catalog: ModelCatalogView,
): FirstRunModelOption[] {
  const supportedModels = supportedRuntimeModels(catalog);
  return supportedModels.map((model) => ({
    value: model.model_ref,
    label: modelDisplayName(model),
    description: `${model.provider_label} - ${tokenWindowLabel(
      model.context_window_tokens,
    )}`,
  }));
}

function resolveSelectedModel(
  catalog: ModelCatalogView,
  settings: Partial<SettingsView>,
  options: FirstRunModelOption[],
): string {
  const values = new Set(options.map((option) => option.value));
  if (settings.model && values.has(settings.model)) return settings.model;
  if (catalog.default_model_ref && values.has(catalog.default_model_ref)) {
    return catalog.default_model_ref;
  }
  return options[0]?.value ?? "";
}

function supportedRuntimeModels(catalog: ModelCatalogView): AppModelSummary[] {
  const registeredModels = Array.isArray(catalog.registered_models)
    ? catalog.registered_models.filter((model) => model.runtime_supported)
    : [];
  if (registeredModels.length > 0) return registeredModels;
  return (catalog.models ?? []).filter((model) => model.runtime_supported);
}
