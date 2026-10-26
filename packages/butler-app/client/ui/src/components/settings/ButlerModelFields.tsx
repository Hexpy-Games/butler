import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { tokenWindowLabel } from "@/app/utils.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { useId } from "react";
import { PercentInputControl, SettingsField, TokenInputControl } from "@/butler-ds";
import { ReasoningSelect } from "./ReasoningSelect";
import { ratioToPercent } from "./settingsUtils";
import { useLocalReasoningBudget } from "./hooks/useLocalReasoningBudget";
import { useButlerModels } from "./hooks/useButlerModels";
import { BackgroundModelSelect } from "./BackgroundModelSelect";
import { ButlerPrimaryModelSelect } from "./ButlerPrimaryModelSelect";

/** Butler model section: primary model (with Manage models), reasoning, context limit, local budget. */
export function ButlerModelFields() {
  useAppLocale();
  const { draft, update, setSettings, models, activeModel, updateSettings } = useButlerModels();
  const saving = useSettingsUIStore((state) => state.saving);
  const openModelManagement = useSettingsUIStore((state) => state.openModelManagement);
  const setModelCatalog = useButlerStore((state) => state.setModelCatalog);
  const settingsCopy = appCopy.settings;
  const fields = settingsCopy.fields;
  const descriptions = settingsCopy.descriptions;
  const activeModelContextMax = activeModel?.context_window_tokens ?? 200_000;
  const activeLocalModel = activeModel?.provider_id === "local" ? activeModel : null;
  const contextLimitId = useId();
  const contextLimitHelpId = useId();
  const localBudgetId = useId();
  const localBudgetHelpId = useId();
  const { updateActiveLocalReasoningBudget } = useLocalReasoningBudget(
    activeLocalModel,
    draft,
    setModelCatalog,
    update,
    settingsCopy,
    setSettings,
  );
  if (!draft) return null;

  return (
    <>
      <ButlerPrimaryModelSelect
        models={models}
        activeModel={activeModel}
        activeModelContextMax={activeModelContextMax}
        draft={draft}
        onManage={openModelManagement}
        onUpdate={updateSettings}
      />
      <ReasoningSelect
        settingId="reasoning"
        label={fields.butlerReasoning}
        triggerTestClass="settings-primary-reasoning-select"
        model={activeModel}
        value={draft.reasoning_effort}
        onChange={(value) => update({ reasoning_effort: value }, setSettings)}
      />
      <SettingsField
        settingId="context-limit"
        id={contextLimitId}
        data-test-class="settings-field"
        label={fields.contextLimit}
        description={descriptions.contextLimit(tokenWindowLabel(activeModelContextMax))}
        descriptionId={contextLimitHelpId}
        control={
          <TokenInputControl
            id={contextLimitId}
            inputLabel={fields.contextLimit}
            sliderLabel={`${fields.contextLimit} slider`}
            describedBy={contextLimitHelpId}
            value={draft.context_window_tokens}
            min={1_000}
            max={activeModelContextMax}
            onCommit={(value, clamped) => {
              void update({ context_window_tokens: value }, setSettings).then(() => {
                if (!clamped) return;
                notifyStatus(descriptions.contextLimitClamped(value.toLocaleString("en-US")), {
                  id: "settings-context-limit",
                  tone: "ok",
                });
              });
            }}
          />
        }
      />
      {activeLocalModel && !activeLocalModel.reasoning_efforts.includes("low") && (
        <SettingsField
          settingId="local-reasoning-budget"
          id={localBudgetId}
          data-test-class="settings-field"
          label={fields.localReasoningBudget}
          description={descriptions.localReasoningBudget}
          descriptionId={localBudgetHelpId}
          control={
            <PercentInputControl
              id={localBudgetId}
              inputLabel={`${fields.localReasoningBudget} percent value`}
              sliderLabel={`${fields.localReasoningBudget} percent slider`}
              describedBy={localBudgetHelpId}
              disabled={saving}
              value={Number(ratioToPercent(activeLocalModel.local_reasoning_budget_ratio))}
              onCommit={(value) => updateActiveLocalReasoningBudget(String(value))}
            />
          }
        />
      )}
      <BackgroundModelSelect models={models} draft={draft} onUpdate={updateSettings} />
    </>
  );
}
