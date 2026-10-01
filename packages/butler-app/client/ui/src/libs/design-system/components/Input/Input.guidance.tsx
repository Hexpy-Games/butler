import type { ShowcaseGuidance } from "../../showcase";
import { SettingsField, SettingsFieldScopeProvider } from "../../blocks/SettingsField";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Input } from "./Input";

// #region recipe: Settings text setting
function DisplayName() {
  return <SettingsFieldScopeProvider><SettingsField id="display-name" label="Display name" description="Shown in Butler messages." control={<Input id="display-name" defaultValue="Butler" />} /></SettingsFieldScopeProvider>;
}
// #endregion

// #region recipe: Compact number in a header
function MaxWorkers() {
  return <Input compact aria-label="Max simultaneous Workers" type="number" inputMode="numeric" min={1} max={8} defaultValue="3" />;
}
// #endregion

// #region recipe: Underline in-place entry
function InlineName() {
  return <Input variant="underline" aria-label="Display name" placeholder="Butler" />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A single-line field for names, IDs, URLs, numbers and secrets. Use variant=default for a box, variant=underline for in-place entry, and compact for a short toolbar field.",
  whenToUse: ["Enter a short value such as a name, ID or URL", "Show a masked or read-only value that people can select"],
  whenNotToUse: [
    { when: "Several lines of text", use: "Textarea" },
    { when: "Choosing from a fixed list", use: "Select" },
    { when: "A token budget with a slider", use: "TokenInputControl" },
    { when: "A percentage with a slider", use: "PercentInputControl" },
  ],
  recipes: [
    { name: "Underline in-place entry", description: "variant=underline removes the box and horizontal padding; use it where a row label becomes editable.", render: () => <InlineName /> },
    { name: "Settings text setting", description: "In settings, the Input is the control of a SettingsField.", render: () => <DisplayName /> },
    { name: "Compact number in a header", description: "compact makes a short inline field for a number in a toolbar; coarse pointers keep the touch target.", render: () => <MaxWorkers /> },
  ],
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
    "Underline uses an inset token outline for keyboard focus: the focus foundation permits inset rings in clipping containers. The accent bottom border also marks pointer focus.",
    "Values use the default text color; placeholders are muted (--placeholder).",
    "aria-invalid=\"true\" draws the danger border; describe the error next to it.",
  ],
  tokens: ["--line-strong", "--border-hairline", "--focus-ring-width", "--focus-ring-color", "--line", "--radius-control", "--placeholder", "--focus-ring", "--color-disabled-bg", "--color-danger-border"],
};
