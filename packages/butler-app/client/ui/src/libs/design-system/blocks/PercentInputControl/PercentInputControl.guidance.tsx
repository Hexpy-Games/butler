import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Slider } from "../../components/Slider";
import { SettingsField } from "../SettingsField";
import { PercentInputControl } from "./PercentInputControl";

// #region recipe: Compaction threshold
function Compaction() {
  const [value, setValue] = useState(64);
  return (
    <SettingsField id="compaction" label="Compact context at" description="Butler summarizes older turns at this share."
      control={<PercentInputControl id="compaction" value={value} onChange={setValue} />} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A percentage control: a slider with a synced number input and bounds.",
  whenToUse: ["A percentage setting that needs both a feel and an exact value"],
  whenNotToUse: [
    { when: "A plain range without exact entry", use: "Slider" },
    { when: "A free number", use: "Input" },
  ],
  recipes: [{ name: "Compaction threshold", description: "Controlled value; min and max clamp both halves.", render: () => <Compaction /> }],
  doDont: [
    {
      do: { caption: "Slider and number stay in sync.", render: () => <Compaction /> },
      dont: { caption: "A slider alone hides the exact percentage.", render: () => <Slider aria-label="Compact at" min={0} max={100} value={64} /> },
    },
  ],
  content: ["The label names the threshold; the description says what happens at it."],
  accessibility: ["Both halves are labelled with the setting name; the input accepts typing and arrow keys."],
  tokens: ["--accent", "--control-height-md", "--space-sm"],
};
