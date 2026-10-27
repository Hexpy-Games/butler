import type { ShowcaseGuidance } from "../../showcase";
import { Card } from "../Card";
import { Input } from "../Input";
import { Label } from "../Label";
import { Stack } from "../Stack";
import { Switch } from "../Switch";
import { Field, FieldContent, FieldDescription, FieldLabel } from "./Field";

// #region recipe: Labelled input with help
function LabelledInput() {
  return (
    <Field>
      <FieldLabel htmlFor="mcp-server-id">Server ID</FieldLabel>
      <Input id="mcp-server-id" defaultValue="github" />
      <FieldDescription>Letters, numbers and dashes.</FieldDescription>
    </Field>
  );
}
// #endregion

// #region recipe: Switch field (stacked, the default)
function StackedSwitchField() {
  return (
    <Field>
      <FieldLabel htmlFor="backup-models">Use backup models</FieldLabel>
      <FieldDescription>Retries with the next model when one fails.</FieldDescription>
      <Switch id="backup-models" defaultChecked />
    </Field>
  );
}
// #endregion

// #region recipe: Switch field (row: a phone, or a list item in a card)
function RowSwitchField() {
  return (
    <Card padding="md">
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="all-conversations">Use in every conversation</FieldLabel>
          <FieldDescription>Butler signs in without asking.</FieldDescription>
        </FieldContent>
        <Switch id="all-conversations" />
      </Field>
    </Card>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Groups a label, a control, help and errors so forms keep one vertical rhythm.",
  whenToUse: ["A form field inside a dialog or an editor form", "Group several fields with FieldSet and FieldGroup"],
  whenNotToUse: [
    { when: "A settings row with label, description and trailing control", use: "SettingsField" },
    { when: "A lone control that only needs a name", use: "Label" },
  ],
  recipes: [
    { name: "Labelled input with help", description: "FieldLabel binds to the control id; FieldDescription follows it.", render: () => <LabelledInput /> },
    {
      name: "Switch field (stacked, the default)",
      description: "Like an input: label, description, then the switch underneath, left-aligned. Every desktop settings field and form.",
      render: () => <StackedSwitchField />,
    },
    {
      name: "Switch field (row: a phone, or a list item in a card)",
      description: "orientation=\"horizontal\" with FieldContent first: label and switch on one row, the switch at the row end, the description under the label. Only on a phone or for a list item inside a closed container.",
      render: () => <RowSwitchField />,
    },
  ],
  doDont: [
    {
      do: { caption: "Field keeps label, control and help together.", render: () => <LabelledInput /> },
      dont: {
        caption: "A hand-built stack drifts from the form rhythm.",
        render: () => <Stack gap="lg"><Label htmlFor="loose">Server ID</Label><Input id="loose" defaultValue="github" /></Stack>,
      },
    },
    {
      do: { caption: "Stacked: a desktop settings field or form puts the switch under its label and description.", render: () => <StackedSwitchField /> },
      dont: {
        caption: "Row layout for a desktop settings field: it is only for a phone or a list item in a card.",
        render: () => (
          <Field orientation="horizontal">
            <FieldContent><FieldLabel htmlFor="row-desktop">Use backup models</FieldLabel></FieldContent>
            <Switch id="row-desktop" defaultChecked />
          </Field>
        ),
      },
    },
    {
      do: { caption: "Row: a list item inside a card keeps the switch at the row end.", render: () => <RowSwitchField /> },
      dont: {
        caption: "A switch before its label.",
        render: () => <Stack align="row" cross="center" gap="sm"><Switch id="switch-first-field" /><Label htmlFor="switch-first-field">Use backup models</Label></Stack>,
      },
    },
  ],
  content: [
    "Vertical labels sit above the control and wrap inside the column, including long unbroken labels.",
    "A switch field stacks like an input (label, description, switch). The row layout (orientation=\"horizontal\") is only for a phone or a list item inside a card or list row.",
    "Labels are nouns (Server ID); descriptions are one sentence; errors say how to fix it.",
  ],
  accessibility: ["Connect help with aria-describedby when it explains the value; FieldError renders role=\"alert\"."],
  tokens: ["--space-sm", "--space-xs", "--text-secondary", "--danger"],
};
