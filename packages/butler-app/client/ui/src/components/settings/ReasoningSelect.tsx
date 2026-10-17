import { appCopy } from "@/app/copy.ts";
import { reasoningOptionLabel } from "@/app/utils.ts";
import type { AppModelSummary, ReasoningEffort } from "@/app/types.ts";
import { SettingsSelect } from "./SettingsSelect";

/** The effort a turn runs with: the stored one when the model offers it, else the model's default. */
export function effectiveReasoningEffort(
  model: AppModelSummary | undefined,
  stored: ReasoningEffort,
): ReasoningEffort {
  const efforts = model?.reasoning_efforts ?? ["none"];
  if (efforts.includes(stored)) return stored;
  if (model && efforts.includes(model.default_reasoning_effort)) return model.default_reasoning_effort;
  return efforts[0] ?? "none";
}

/**
 * A reasoning select for `model`. It always shows the effective effort, so it
 * is never empty; with no choice to make (one option or none) it is disabled
 * and says why in a tooltip.
 */
export function ReasoningSelect({
  model,
  value,
  onChange,
  ...field
}: {
  model: AppModelSummary | undefined;
  value: ReasoningEffort;
  onChange: (value: ReasoningEffort) => void;
  label: string;
  settingId?: string;
  disabled?: boolean;
  triggerTestClass?: string;
}) {
  const efforts = model?.reasoning_efforts ?? ["none"];
  const fixed = efforts.length <= 1;
  return (
    <SettingsSelect
      {...field}
      value={effectiveReasoningEffort(model, value)}
      disabledReason={fixed ? appCopy.settings.descriptions.reasoningFixed : undefined}
      onChange={(next) => onChange(next as ReasoningEffort)}
      options={efforts.map((effort) => ({ value: effort, label: reasoningOptionLabel(model, effort) }))}
    />
  );
}
