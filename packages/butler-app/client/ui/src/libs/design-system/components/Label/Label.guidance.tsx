import type { ShowcaseGuidance } from "../../showcase";
import { Field } from "../Field";
import { Stack } from "../Stack";
import { Switch } from "../Switch";
import { Typo } from "../Typo";
import { Label } from "./Label";

// #region recipe: Switch with a label
function LabelledSwitch() {
  return (
    <Field>
      <Label htmlFor="developer-mode">Developer mode</Label>
      <Switch id="developer-mode" />
    </Field>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Names one form control and makes its text a click target for it.",
  whenToUse: ["Name a lone control outside a Field", "A switch and its label: the label above, the switch underneath (a stacked Field)"],
  whenNotToUse: [
    { when: "A label inside a form field", use: "FieldLabel" },
    { when: "A settings row", use: "SettingsField" },
  ],
  recipes: [{
    name: "Switch with a label",
    description: "A switch field stacks like an input: the label, then the switch underneath. htmlFor points at the control id so clicking the text toggles it. The row layout is Field orientation=\"horizontal\", only on a phone or for a list item in a card.",
    render: () => <LabelledSwitch />,
  }],
  doDont: [
    {
      do: { caption: "The label, then the switch underneath.", render: () => <LabelledSwitch /> },
      dont: {
        caption: "A switch before its label.",
        render: () => <Stack align="row" cross="center" gap="sm"><Switch id="switch-first" /><Label htmlFor="switch-first">Developer mode</Label></Stack>,
      },
    },
    {
      do: { caption: "Label with htmlFor: the text is part of the target.", render: () => <LabelledSwitch /> },
      dont: {
        caption: "Plain text next to a control is not announced as its name.",
        render: () => <Field><Typo.Body>Developer mode</Typo.Body><Switch aria-label="unnamed" /></Field>,
      },
    },
  ],
  content: [
    "Short noun phrases; sentence case in English.",
    "A switch field stacks like an input: label, description, then the switch. See Switch \"Placement\" for the row exception.",
  ],
  accessibility: ["Every control needs exactly one accessible name: a Label, a FieldLabel or aria-label."],
  tokens: ["--typo-label-size", "--font-weight-medium"],
};
