import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../Stack";
import { Switch } from "../Switch";
import { Typo } from "../Typo";
import { Label } from "./Label";

// #region recipe: Switch with a label
function LabelledSwitch() {
  return (
    <Stack align="row" cross="center" justify="between" gap="sm">
      <Label htmlFor="developer-mode">Developer mode</Label>
      <Switch id="developer-mode" />
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Names one form control and makes its text a click target for it.",
  whenToUse: ["Name a lone control outside a Field", "A switch or checkbox and its label on one line: label first, control at the line end"],
  whenNotToUse: [
    { when: "A label inside a form field", use: "FieldLabel" },
    { when: "A settings row", use: "SettingsField" },
  ],
  recipes: [{
    name: "Switch with a label",
    description: "The label comes first and the switch sits at the line end; htmlFor points at the control id so clicking the text toggles it.",
    render: () => <LabelledSwitch />,
  }],
  doDont: [
    {
      do: { caption: "Label first, the switch at the line end.", render: () => <LabelledSwitch /> },
      dont: {
        caption: "A switch before its label.",
        render: () => <Stack align="row" cross="center" gap="sm"><Switch id="switch-first" /><Label htmlFor="switch-first">Developer mode</Label></Stack>,
      },
    },
    {
      do: { caption: "Label with htmlFor: the text is part of the target.", render: () => <LabelledSwitch /> },
      dont: {
        caption: "Plain text next to a control is not announced as its name.",
        render: () => <Stack align="row" cross="center" justify="between" gap="sm"><Typo.Body>Developer mode</Typo.Body><Switch aria-label="unnamed" /></Stack>,
      },
    },
  ],
  content: [
    "Short noun phrases; sentence case in English.",
    "On one line the label comes first and the control (a switch, a checkbox) sits at the line end.",
  ],
  accessibility: ["Every control needs exactly one accessible name: a Label, a FieldLabel or aria-label."],
  tokens: ["--typo-label-size", "--font-weight-medium"],
};
