import type { ShowcaseGuidance } from "../../showcase";
import { Field, FieldLabel } from "../../components/Field";
import { Input } from "../../components/Input";
import { Switch } from "../../components/Switch";
import { Stack } from "../../components/Stack";
import { SettingsField, SettingsFieldGroup } from "./SettingsField";
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

// #region recipe: Fields revealed together
function AdvancedHosts() {
  return (
    <SettingsFieldScopeProvider>
      <SettingsFieldGroup id="advanced-hosts">
        <SettingsField id="hosts" label="Allowed hosts" description="Hosts Butler may open without asking." control={<Input id="hosts" defaultValue="example.com" />} />
        <SettingsField id="content-hosts" label="Content hosts" description="Hosts whose pages Butler may read." control={<Input id="content-hosts" />} />
      </SettingsFieldGroup>
    </SettingsFieldScopeProvider>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "One setting: label, description, control and optional meta on the settings spacing ramp.",
  whenToUse: ["Every setting inside a FormSection or a dialog form"],
  whenNotToUse: [
    { when: "A field in a compact editor inside a list row (Vault profile)", use: "Field" },
    { when: "A setting that is only an action (free up space, reset, clear)", use: "SettingsActionField" },
    { when: "A group of secret key/value rows", use: "SettingsSecretRows" },
  ],
  recipes: [
    { name: "Labelled setting with a description", description: "id ties the label and description to the control.", render: () => <SmartGroups /> },
    { name: "Fields revealed together", description: "SettingsFieldGroup gives a disclosure panel or row editor its own element at the field gap.", render: () => <AdvancedHosts /> },
  ],
  doDont: [
    {
      do: { caption: "The ramp: label → description (4px) → control (8px); fields 24px apart.", render: () => <SmartGroups /> },
      dont: { caption: "A bare Field in settings breaks the ramp.", render: () => <Field><FieldLabel htmlFor="sg">Smart groups</FieldLabel><Input id="sg" /></Field> },
    },
    {
      do: { caption: "Fields revealed together share SettingsFieldGroup, spaced by the field gap.", render: () => <AdvancedHosts /> },
      dont: {
        caption: "A Stack gap between fields makes the gap between settings as small as the gap inside one.",
        render: () => (
          <SettingsFieldScopeProvider>
            <Stack gap="sm">
              <SettingsField id="hosts-x" label="Allowed hosts" description="Hosts Butler may open without asking." control={<Input id="hosts-x" />} />
              <SettingsField id="content-x" label="Content hosts" description="Hosts whose pages Butler may read." control={<Input id="content-x" />} />
            </Stack>
          </SettingsFieldScopeProvider>
        ),
      },
    },
  ],
  content: [
    "Labels name the setting; descriptions explain the effect in one sentence.",
    "error is a few words saying what is wrong (\"Port must be a number\"), not how the app failed.",
    "afterControl is live state under the control (\"Downloading · 40%\"); meta is facts about the setting (sizes, counts, last change).",
  ],
  accessibility: [
    "The control gets the label via id; SettingsField adds the description and error ids to its aria-describedby.",
    "error sets aria-invalid on the control and renders a FieldError (role=alert) under it.",
  ],
  tokens: ["--settings-field-copy-gap", "--settings-field-control-gap", "--settings-field-gap"],
};
