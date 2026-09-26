import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../Stack";
import { Switch } from "../Switch";
import { Typo } from "../Typo";
import { Label } from "./Label";

// #region recipe: Switch with a label
function LabelledSwitch() {
  return (
    <Stack align="row" cross="center" gap="sm">
      <Switch id="developer-mode" />
      <Label htmlFor="developer-mode">Developer mode</Label>
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Names one form control and makes its text a click target for it.",
  whenToUse: ["Name a lone control outside a Field"],
  whenNotToUse: [
    { when: "A label inside a form field", use: "FieldLabel" },
    { when: "A settings row", use: "SettingsField" },
  ],
  recipes: [{ name: "Switch with a label", description: "htmlFor points at the control id so clicking the text toggles it.", render: () => <LabelledSwitch /> }],
  doDont: [
    {
      do: { caption: "Label with htmlFor: the text is part of the target.", render: () => <LabelledSwitch /> },
      dont: {
        caption: "Plain text next to a control is not announced as its name.",
        render: () => <Stack align="row" cross="center" gap="sm"><Switch aria-label="unnamed" /><Typo.Body>Developer mode</Typo.Body></Stack>,
      },
    },
  ],
  content: ["Short noun phrases; sentence case in English."],
  accessibility: ["Every control needs exactly one accessible name: a Label, a FieldLabel or aria-label."],
  tokens: ["--typo-label-size", "--font-weight-medium"],
};
