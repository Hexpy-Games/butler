import type { ShowcaseGuidance } from "../../showcase";
import { SettingsField, SettingsFieldScopeProvider } from "../../blocks/SettingsField";
import { Input } from "../Input";
import { ColorSwatchInput } from "./ColorSwatchInput";

// #region recipe: Theme color setting
function ThemeColor() {
  return <SettingsFieldScopeProvider><SettingsField id="accent-color" label="Accent color" control={<ColorSwatchInput id="accent-color" aria-label="Accent color" defaultValue="#007aff" />} /></SettingsFieldScopeProvider>;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A round swatch that opens the system color picker for one color value.",
  whenToUse: ["Let people pick a theme or fluid-background color"],
  whenNotToUse: [
    { when: "Typing a hex value precisely", use: "Input" },
    { when: "Choosing among a few named colors", use: "SegmentedControl" },
  ],
  recipes: [{ name: "Theme color setting", description: "Inside a SettingsField, the swatch is the control.", render: () => <ThemeColor /> }],
  doDont: [
    {
      do: { caption: "A labelled swatch shows the color itself.", render: () => <ColorSwatchInput aria-label="Accent color" defaultValue="#007aff" /> },
      dont: { caption: "A text field for a color hides the result.", render: () => <Input aria-label="Accent color" defaultValue="#007aff" /> },
    },
  ],
  content: ["Show the chosen hex next to the swatch when the exact value matters."],
  accessibility: ["Always pass aria-label or an id tied to a label; the swatch has no text."],
  tokens: ["--radius-pill", "--line", "--focus-ring"],
};
