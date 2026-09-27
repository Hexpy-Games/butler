import type { ShowcaseGuidance } from "../../showcase";
import { Input } from "../Input";
import { Label } from "../Label";
import { Stack } from "../Stack";
import { Field, FieldDescription, FieldLabel } from "./Field";

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

export const guidance: ShowcaseGuidance = {
  purpose: "Groups a label, a control, help and errors so forms keep one vertical rhythm.",
  whenToUse: ["A form field inside a dialog or an editor form", "Group several fields with FieldSet and FieldGroup"],
  whenNotToUse: [
    { when: "A settings row with label, description and trailing control", use: "SettingsField" },
    { when: "A lone control that only needs a name", use: "Label" },
  ],
  recipes: [{ name: "Labelled input with help", description: "FieldLabel binds to the control id; FieldDescription follows it.", render: () => <LabelledInput /> }],
  doDont: [
    {
      do: { caption: "Field keeps label, control and help together.", render: () => <LabelledInput /> },
      dont: {
        caption: "A hand-built stack drifts from the form rhythm.",
        render: () => <Stack gap="lg"><Label htmlFor="loose">Server ID</Label><Input id="loose" defaultValue="github" /></Stack>,
      },
    },
  ],
  content: ["Labels are nouns (Server ID); descriptions are one sentence; errors say how to fix it."],
  accessibility: ["Connect help with aria-describedby when it explains the value; FieldError renders role=\"alert\"."],
  tokens: ["--space-sm", "--space-xs", "--text-secondary", "--danger"],
};
