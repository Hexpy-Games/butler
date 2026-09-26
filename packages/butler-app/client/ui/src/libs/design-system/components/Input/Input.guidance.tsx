import type { ShowcaseGuidance } from "../../showcase";
import { SettingsField } from "../../blocks/SettingsField";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Input } from "./Input";

// #region recipe: Settings text setting
function DisplayName() {
  return <SettingsField id="display-name" label="Display name" description="Shown in Butler messages." control={<Input id="display-name" defaultValue="Butler" />} />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A single-line text box for names, IDs, URLs, numbers and secrets.",
  whenToUse: ["Enter a short value such as a name, ID or URL", "Show a masked or read-only value that people can select"],
  whenNotToUse: [
    { when: "Several lines of text", use: "Textarea" },
    { when: "Choosing from a fixed list", use: "Select" },
    { when: "A comma-separated list of tokens", use: "TokenInputControl" },
    { when: "A percentage with a slider", use: "PercentInputControl" },
  ],
  recipes: [{ name: "Settings text setting", description: "In settings, the Input is the control of a SettingsField.", render: () => <DisplayName /> }],
  doDont: [
    {
      do: { caption: "Label it (FieldLabel, SettingsField or aria-label); the placeholder only hints.", render: () => <DisplayName /> },
      dont: {
        caption: "A placeholder as the only label disappears as soon as someone types.",
        render: () => <Stack gap="xs"><Input placeholder="Display name" /><Typo.Caption tone="tertiary">No label</Typo.Caption></Stack>,
      },
    },
  ],
  content: ["Placeholders show an example value (github, https://…), never instructions."],
  accessibility: [
    "Values use the default text color; placeholders are muted (--placeholder).",
    "aria-invalid=\"true\" draws the danger border; describe the error next to it.",
  ],
  tokens: ["--line", "--radius-control", "--placeholder", "--focus-ring", "--color-disabled-bg", "--color-danger-border"],
};
