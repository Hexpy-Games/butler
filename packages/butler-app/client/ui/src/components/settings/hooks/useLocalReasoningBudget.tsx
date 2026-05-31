import { api } from "@/app/api.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { percentToRatio, localModelMutationPayload } from "../settingsUtils";
import type {
  AppModelSummary,
  LocalModelRegistrationResult,
  ModelCatalogView,
  SettingsView as SettingsData,
} from "@/app/types.ts";
import type { SettingsCopy } from "../settingsTypes";

export function useLocalReasoningBudget(
  activeLocalModel: AppModelSummary | null,
  draft: SettingsData,
  setModelCatalog: (catalog: ModelCatalogView) => void,
  update: (
    partial: Partial<SettingsData>,
    onSettingsChange: (settings: SettingsData) => void,
  ) => Promise<void>,
  settingsCopy: SettingsCopy,
  setSettings: (settings: SettingsData) => void,
) {
  async function updateActiveLocalReasoningBudget(
    percentText: string,
  ): Promise<boolean> {
    if (!activeLocalModel) return false;
    const ratio = percentToRatio(percentText);
    try {
      const result = await api<LocalModelRegistrationResult>(
        `/model-catalog/local-models/${encodeURIComponent(activeLocalModel.model_ref)}`,
        {
          method: "PATCH",
          body: JSON.stringify(
            localModelMutationPayload(activeLocalModel, ratio),
          ),
        },
      );
      setModelCatalog(result.catalog);
      if (
        ratio > 0 &&
        draft.model === result.model.model_ref &&
        draft.reasoning_effort === "none"
      ) {
        await update(
          {
            reasoning_effort: result.model.default_reasoning_effort,
          },
          setSettings,
        );
      }
      notifyStatus(settingsCopy.saved, {
        id: "settings-local-reasoning-budget",
        tone: "ok",
      });
      return true;
    } catch (error) {
      notifyError(error, settingsCopy.errors.updateLocalReasoningBudget, {
        id: "settings-local-reasoning-budget",
      });
      return false;
    }
  }

  return { updateActiveLocalReasoningBudget };
}
