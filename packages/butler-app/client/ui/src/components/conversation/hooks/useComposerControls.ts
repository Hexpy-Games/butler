import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import { notifyError } from "@/app/notifications.ts";
import { EMPTY_MODEL_CATALOG } from "@/app/constants.ts";
import { isDraftChatId, runtimeModels } from "@/app/utils.ts";
import type {
  AccessMode,
  ModelCatalogView,
  ReasoningEffort,
  SessionControlsView,
  SettingsView as SettingsData,
} from "@/app/types.ts";

export type ComposerControlPatch = {
  model?: string;
  reasoning_effort?: ReasoningEffort;
  access_mode?: AccessMode;
  plan_mode?: boolean;
};

export function useComposerControls(
  activeChatId: string,
  modelCatalog: ModelCatalogView,
  settings: SettingsData,
) {
  const [model, setModel] = useState(
    settings.model || modelCatalog.default_model_ref,
  );
  const [reasoning, setReasoning] = useState(settings.reasoning_effort);
  const [accessMode, setAccessMode] = useState(settings.access_mode);
  const [planMode, setPlanMode] = useState(Boolean(settings.plan_mode_default));
  const controlsLoadedForRef = useRef<string | null>(null);
  const composerSelectionTouchedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const nextModels = runtimeModels(modelCatalog);

    function applyControls(controls: {
      model?: string;
      reasoning_effort?: ReasoningEffort;
      access_mode?: AccessMode;
      plan_mode?: boolean;
    }) {
      const preferredModel =
        controls.model ||
        settings.model ||
        modelCatalog.default_model_ref ||
        EMPTY_MODEL_CATALOG.default_model_ref;
      const nextModel = nextModels.some(
        (item) => item.model_ref === preferredModel,
      )
        ? preferredModel
        : (nextModels[0]?.model_ref ?? EMPTY_MODEL_CATALOG.default_model_ref);
      const modelMeta = nextModels.find((item) => item.model_ref === nextModel);
      const nextReasoning =
        controls.reasoning_effort ||
        settings.reasoning_effort ||
        modelMeta?.default_reasoning_effort ||
        "medium";
      const preferredReasoning: ReasoningEffort =
        modelMeta?.provider_id === "local" &&
        modelMeta.local_reasoning_budget_ratio &&
        nextReasoning === "none" &&
        !controls.reasoning_effort
          ? modelMeta.default_reasoning_effort
          : nextReasoning;
      setModel(nextModel);
      setReasoning(
        modelMeta?.reasoning_efforts?.includes(preferredReasoning)
          ? preferredReasoning
          : (modelMeta?.default_reasoning_effort ?? "medium"),
      );
      setAccessMode(
        controls.access_mode || settings.access_mode || "full_access",
      );
      setPlanMode(Boolean(controls.plan_mode ?? settings.plan_mode_default));
    }

    if (isDraftChatId(activeChatId)) {
      const key = `draft:${activeChatId}`;
      if (
        controlsLoadedForRef.current !== key ||
        !composerSelectionTouchedRef.current
      ) {
        controlsLoadedForRef.current = key;
        applyControls({});
      }
      return;
    }

    const key = `session:${activeChatId}`;
    if (controlsLoadedForRef.current === key) return;
    controlsLoadedForRef.current = key;
    api<SessionControlsView>(
      `/sessions/${encodeURIComponent(activeChatId)}/controls`,
    )
      .then((data) => {
        if (!cancelled) applyControls(data.controls ?? {});
      })
      .catch((error) => {
        if (!cancelled) {
          notifyError(error, "Session controls failed", {
            id: `session-controls-${activeChatId}`,
          });
          applyControls({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeChatId,
    modelCatalog.default_model_ref,
    modelCatalog.generated_at,
    settings.access_mode,
    settings.model,
    settings.plan_mode_default,
    settings.reasoning_effort,
  ]);

  const persistControls = useCallback((partial: ComposerControlPatch) => {
    if (isDraftChatId(activeChatId)) return;
    void api<SessionControlsView>(
      `/sessions/${encodeURIComponent(activeChatId)}/controls`,
      {
        method: "PATCH",
        body: JSON.stringify(partial),
      },
    ).catch((error) => {
      notifyError(error, "Session controls failed", {
        id: `session-controls-${activeChatId}`,
      });
    });
  }, [activeChatId]);

  return {
    model,
    setModel,
    reasoning,
    setReasoning,
    accessMode,
    setAccessMode,
    planMode,
    setPlanMode,
    persistControls,
    composerSelectionTouchedRef,
  };
}
