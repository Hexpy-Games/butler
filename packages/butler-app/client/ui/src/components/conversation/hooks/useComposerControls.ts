import { appCopy } from "@/app/copy.ts";
import { useEffect, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import { notifyError } from "@/app/notifications.ts";
import { useButlerStore } from "@/app/store.ts";
import type {
  AccessMode,
  ComposerModelState,
  ModelCatalogState,
  ModelCatalogView,
  ReasoningEffort,
  SettingsView as SettingsData,
} from "@/app/types.ts";
import { useSessionControlSnapshot } from "./useSessionControlSnapshot.ts";
import { resolveComposerModelTruth } from "../composerModelResolution.ts";
import { activeProjectId } from "../composerProjectContext.ts";

export type ComposerControlPatch = {
  model?: string;
  reasoning_effort?: ReasoningEffort;
  access_mode?: AccessMode;
  plan_mode?: boolean;
};

export function useComposerControls(
  activeChatId: string,
  modelCatalog: ModelCatalogView,
  modelCatalogState: ModelCatalogState,
  settings: SettingsData,
) {
  const [model, setModel] = useState("");
  const [modelState, setModelState] =
    useState<ComposerModelState>("loading");
  const [reasoning, setReasoning] = useState<ReasoningEffort>("medium");
  const [accessMode, setAccessMode] = useState(settings.access_mode);
  const navigation = useButlerStore((state) => state.navigation);
  const planModeAvailable = Boolean(activeProjectId(navigation, activeChatId));
  const [planMode, setPlanMode] = useState(
    planModeAvailable && Boolean(settings.plan_mode_default),
  );
  const session = useSessionControlSnapshot(activeChatId);
  const composerSelectionTouchedRef = useRef(false);
  const refreshedGenerationRef = useRef<string | null>(null);
  const setGlobalModelCatalog = useButlerStore(
    (state) => state.setModelCatalog,
  );

  useEffect(() => {
    composerSelectionTouchedRef.current = false;
    refreshedGenerationRef.current = null;
  }, [activeChatId]);

  useEffect(() => {
    if (!planModeAvailable) setPlanMode(false);
  }, [planModeAvailable]);

  useEffect(() => {
    const truth = resolveComposerModelTruth({
      catalog: modelCatalog,
      catalogState: modelCatalogState,
      controls: session.snapshot,
      controlsState: session.loadState,
      settings,
      planModeAvailable,
    });
    setModelState(truth.state);
    if (truth.state !== "ready") setModel(truth.model);
    if (truth.generationMismatch && session.snapshot) {
      const generationKey = `${session.snapshot.catalog_generation}:${modelCatalog.generation}`;
      if (refreshedGenerationRef.current !== generationKey) {
        refreshedGenerationRef.current = generationKey;
        void api<ModelCatalogView>("/model-catalog")
          .then((catalog) => {
            if (catalog.generation !== session.snapshot?.catalog_generation) {
              setModelState("error");
              return;
            }
            setGlobalModelCatalog(catalog);
          })
          .catch((error) => {
            setModelState("error");
            notifyError(error, appCopy.interfacePanels.modelRefreshFailed, {
              id: `model-catalog-generation-${activeChatId}`,
            });
          });
      }
      return;
    }
    if (truth.state === "ready" && !composerSelectionTouchedRef.current) {
      setModel(truth.model);
      setReasoning(truth.reasoning);
      setAccessMode(truth.accessMode);
      setPlanMode(truth.planMode);
    }
  }, [
    activeChatId,
    modelCatalog,
    modelCatalogState,
    planModeAvailable,
    session.loadState,
    session.snapshot,
    setGlobalModelCatalog,
    settings,
  ]);

  return {
    model,
    modelState,
    setModel,
    reasoning,
    setReasoning,
    accessMode,
    setAccessMode,
    planMode,
    setPlanMode,
    persistControls: session.persist,
    composerSelectionTouchedRef,
  };
}
