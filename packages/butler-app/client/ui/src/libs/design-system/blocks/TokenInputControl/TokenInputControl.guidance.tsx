import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Input } from "../../components/Input";
import { SettingsField, SettingsFieldScopeProvider } from "../SettingsField";
import { TokenInputControl } from "./TokenInputControl";

// #region recipe: Context limit
function ContextLimit() {
  const [value, setValue] = useState(200000);
  return (
    <SettingsFieldScopeProvider>
      <SettingsField id="context-limit" label="Context limit" description="Maximum tokens kept in context."
        descriptionId="context-limit-help"
        control={<TokenInputControl id="context-limit" inputLabel="Context limit" sliderLabel="Context limit slider"
          describedBy="context-limit-help" min={1000} max={400000} value={value}
          onCommit={(next) => setValue(next)} />} />
    </SettingsFieldScopeProvider>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A token budget setting: a number input and a slider over the model's range, with a value / max readout.",
  whenToUse: ["A token limit bounded by the active model"],
  whenNotToUse: [
    { when: "A percentage", use: "PercentInputControl" },
    { when: "A free number", use: "Input" },
  ],
  recipes: [{ name: "Context limit", description: "Typed values accept 120,000 or 120_000 and clamp to min and max; onCommit reports clamping.", render: () => <ContextLimit /> }],
  doDont: [
    {
      do: { caption: "The readout shows the budget against the model maximum.", render: () => <ContextLimit /> },
      dont: { caption: "A bare input hides the allowed range.", render: () => <Input aria-label="Context limit" defaultValue="200000" /> },
    },
  ],
  content: ["The description names the model maximum; tell the user when a value was clamped."],
  accessibility: ["Both halves carry their own accessible name and describe themselves with the field help text."],
  tokens: ["--accent", "--control-height-md", "--space-sm"],
};
