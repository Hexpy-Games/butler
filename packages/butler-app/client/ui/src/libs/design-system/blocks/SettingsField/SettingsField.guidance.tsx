import type { ShowcaseGuidance } from "../../showcase";
import { Field, FieldLabel } from "../../components/Field";
import { Input } from "../../components/Input";
import { Switch } from "../../components/Switch";
import { SettingsField } from "./SettingsField";
import { SettingsFieldScopeProvider } from "./settingsFieldScope";

// #region recipe: Labelled setting with a description
function SmartGroups() {
  return (
    <SettingsFieldScopeProvider>
      <SettingsField id="smart-groups" label="Smart groups" description="Organize new conversations by topic automatically."
        control={<Switch id="smart-groups" defaultChecked />} />
    </SettingsFieldScopeProvider>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "One setting: label, description, control and optional meta on the settings spacing ramp.",
  whenToUse: ["Every setting inside a FormSection or a dialog form"],
  whenNotToUse: [
    { when: "A field in an editor form (MCP server, persona)", use: "Field" },
    { when: "A group of secret key/value rows", use: "SettingsSecretRows" },
  ],
  recipes: [{ name: "Labelled setting with a description", description: "id ties the label and description to the control.", render: () => <SmartGroups /> }],
  doDont: [
    {
      do: { caption: "The ramp: label → description (6px) → control (12px).", render: () => <SmartGroups /> },
      dont: { caption: "A bare Field in settings breaks the ramp.", render: () => <Field><FieldLabel htmlFor="sg">Smart groups</FieldLabel><Input id="sg" /></Field> },
    },
  ],
  content: [
    "Labels name the setting; descriptions explain the effect in one sentence.",
    "error is a few words saying what is wrong (\"Port must be a number\"), not how the app failed.",
  ],
  accessibility: [
    "The control gets the label via id; SettingsField adds the description and error ids to its aria-describedby.",
    "error sets aria-invalid on the control and renders a FieldError (role=alert) under it.",
  ],
  tokens: ["--settings-field-copy-gap", "--settings-field-control-gap", "--settings-field-gap"],
};
