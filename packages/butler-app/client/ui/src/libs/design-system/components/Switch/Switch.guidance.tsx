import type { ShowcaseGuidance } from "../../showcase";
import { SettingsField, SettingsFieldScopeProvider } from "../../blocks/SettingsField";
import { Button } from "../Button";
import { Switch } from "./Switch";

// #region recipe: Settings toggle
function SettingsToggle() {
  return (
    <SettingsFieldScopeProvider>
      <SettingsField id="backup-models" label="Use backup models" description="Retry with the next model when the main one fails."
        control={<Switch id="backup-models" defaultChecked />} />
    </SettingsFieldScopeProvider>
  );
}
// #endregion

// #region recipe: Setting unavailable on this device
function UnavailableToggle() {
  return (
    <SettingsFieldScopeProvider>
      <SettingsField id="command-sandbox" label="Command sandbox" description="Runs commands that change files in an isolated environment."
        control={<Switch id="command-sandbox" checked={false} disabledReason="Not available on this device" />} />
    </SettingsFieldScopeProvider>
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
  recipes: [
    { name: "Settings toggle", description: "In settings the switch stacks under its label and description.", render: () => <SettingsToggle /> },
    {
      name: "Setting unavailable on this device",
      description: "disabledReason names why; hover or focus opens it to the right of the switch, clear of the label and description.",
      render: () => <UnavailableToggle />,
    },
  ],
  doDont: [
    {
      do: { caption: "The switch changes state right away; the label names the setting.", render: () => <SettingsToggle /> },
      dont: { caption: "A button that toggles text (Enable/Disable) hides the current state.", render: () => <Button variant="outline" text="Enable backup models" /> },
    },
  ],
  content: [
    "Label first, switch at the line end: never put the switch before its label.",
    "Name the setting, not the action: Use backup models, not Turn on backup models.",
    "disabledReason is a few words (Follows the system setting), never an explanation paragraph.",
    "The reason opens to the right of the switch (disabledReasonSide, default right; disabledReasonAlign, default center). Change it only when something the reader needs sits to the right.",
  ],
  accessibility: [
    "role=switch with aria-checked; bind the label with id, and the description with aria-describedby.",
    "disabledReason keeps the switch focusable (aria-disabled) so keyboard and pointer users can read the reason tooltip.",
    "A tap on a touch screen does not open the reason tooltip yet.",
  ],
  tokens: ["--switch-track-bg", "--switch-thumb", "--accent", "--motion-ease-spring", "--motion-base"],
};
