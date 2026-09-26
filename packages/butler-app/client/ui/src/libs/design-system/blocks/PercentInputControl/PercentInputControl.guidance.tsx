import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Slider } from "../../components/Slider";
import { SettingsField, SettingsFieldScopeProvider } from "../SettingsField";
import { PercentInputControl } from "./PercentInputControl";

// #region recipe: Reasoning budget
function ReasoningBudget() {
  const [value, setValue] = useState(40);
  return (
    <SettingsFieldScopeProvider>
      <SettingsField id="budget" label="Local reasoning budget" description="Share of the context spent on reasoning."
        descriptionId="budget-help"
        control={<PercentInputControl id="budget" inputLabel="Local reasoning budget percent value"
          sliderLabel="Local reasoning budget percent slider" describedBy="budget-help" value={value}
          onCommit={(next) => { setValue(next); return true; }} />} />
    </SettingsFieldScopeProvider>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A percentage setting: a number input and a slider that commit together, with a percent readout.",
  whenToUse: ["A percentage setting that needs both a feel and an exact value"],
  whenNotToUse: [
    { when: "A plain range without exact entry", use: "Slider" },
    { when: "A token budget", use: "TokenInputControl" },
  ],
  recipes: [{ name: "Reasoning budget", description: "Commits on blur, Enter or slider release; resolve false to roll back.", render: () => <ReasoningBudget /> }],
  doDont: [
    {
      do: { caption: "Input, slider and readout stay in sync.", render: () => <ReasoningBudget /> },
      dont: { caption: "A slider alone hides the exact percentage.", render: () => <Slider aria-label="Budget" min={0} max={100} value={40} /> },
    },
  ],
  content: ["The field label names the setting; the description says what the share controls."],
  accessibility: ["Both halves carry their own accessible name and describe themselves with the field help text."],
  tokens: ["--accent", "--control-height-md", "--space-sm"],
};
