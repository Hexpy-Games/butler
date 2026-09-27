import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Input } from "../Input";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Slider } from "./Slider";

// #region recipe: Slider with a live readout
function ContextLimit() {
  const [value, setValue] = useState(285000);
  return (
    <Stack gap="xs">
      <Stack align="row" justify="between">
        <Typo.Label>Context limit</Typo.Label>
        <Typo.Caption tone="secondary">{`${value.toLocaleString("en-US")} tokens`}</Typo.Caption>
      </Stack>
      <Slider aria-label="Context limit" min={1000} max={1000000} step={1000} value={value} onValueChange={setValue} />
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A controlled range input for choosing a number between bounds by feel.",
  whenToUse: ["Adjust a budget or threshold where the rough position matters more than the exact digit"],
  whenNotToUse: [
    { when: "An exact number must be typed", use: "Input" },
    { when: "A percentage with both slider and input", use: "PercentInputControl" },
  ],
  recipes: [{ name: "Slider with a live readout", description: "Always show the current value next to the label.", render: () => <ContextLimit /> }],
  doDont: [
    {
      do: { caption: "A readout makes the chosen value explicit.", render: () => <ContextLimit /> },
      dont: { caption: "A number field for a fuzzy threshold forces people to guess digits.", render: () => <Input aria-label="Context limit" inputMode="numeric" defaultValue="285000" /> },
    },
  ],
  content: ["Format readouts with the locale (285,000 tokens / 285,000 토큰) and units."],
  accessibility: ["Pass aria-label (or describe with aria-describedby); arrow keys step by step."],
  tokens: ["--accent", "--selection", "--focus-ring"],
};
