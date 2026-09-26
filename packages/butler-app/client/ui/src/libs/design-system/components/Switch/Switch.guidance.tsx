import type { ShowcaseGuidance } from "../../showcase";
import { SettingsField } from "../../blocks/SettingsField";
import { Button } from "../Button";
import { Switch } from "./Switch";

// #region recipe: Settings toggle
function SettingsToggle() {
  return (
    <SettingsField id="backup-models" label="Use backup models" description="Retry with the next model when the main one fails."
      control={<Switch id="backup-models" defaultChecked />} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "An on/off setting that takes effect immediately.",
  whenToUse: ["Turn a setting on or off without a save step"],
  whenNotToUse: [
    { when: "Choosing among several modes", use: "SegmentedControl" },
    { when: "An action that runs once", use: "Button" },
  ],
  recipes: [{ name: "Settings toggle", description: "In settings the switch stacks under its label and description.", render: () => <SettingsToggle /> }],
  doDont: [
    {
      do: { caption: "The switch changes state right away; the label names the setting.", render: () => <SettingsToggle /> },
      dont: { caption: "A button that toggles text (Enable/Disable) hides the current state.", render: () => <Button variant="outline" text="Enable backup models" /> },
    },
  ],
  content: ["Name the setting, not the action: Use backup models, not Turn on backup models."],
  accessibility: ["role=switch with aria-checked; bind the label with id, and the description with aria-describedby."],
  tokens: ["--switch-track-bg", "--switch-thumb", "--accent", "--motion-ease-spring", "--motion-base"],
};
