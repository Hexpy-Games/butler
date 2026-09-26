import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { Trash2 } from "../../components/Icons";
import { Input } from "../../components/Input";
import { NativeSelect, NativeSelectOption } from "../../components/NativeSelect";
import { Stack } from "../../components/Stack";
import { SettingsSecretRow, SettingsSecretRows } from "./SettingsSecretRows";

// #region recipe: Secret headers
function SecretHeaders() {
  return (
    <SettingsSecretRows title="Headers" actions={<Button size="xs" variant="outline" text="Add header" />}>
      <SettingsSecretRow
        sourceControl={<NativeSelect aria-label="Value source" defaultValue="env"><NativeSelectOption value="env">Environment variable</NativeSelectOption></NativeSelect>}
        keyControl={<Input aria-label="Headers key" defaultValue="Authorization" />}
        valueControl={<Input aria-label="Headers value" defaultValue="BUTLER_GITHUB_TOKEN" />}
        actionControl={<IconButton label="Delete row"><Trash2 size="sm" /></IconButton>} />
    </SettingsSecretRows>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Editable key/value secret rows with a value source per row and a shared toolbar.",
  whenToUse: ["MCP headers and environment variables whose values may come from env or the keychain"],
  whenNotToUse: [
    { when: "Read-only facts", use: "KeyValueRow" },
    { when: "A single secret", use: "SettingsField" },
  ],
  recipes: [{ name: "Secret headers", description: "Source, key, value and delete per row; the toolbar adds rows.", render: () => <SecretHeaders /> }],
  doDont: [
    {
      do: { caption: "The value source says where the secret comes from.", render: () => <SecretHeaders /> },
      dont: { caption: "Two loose inputs cannot say whether the value is literal or a reference.", render: () => <Stack align="row" gap="sm"><Input aria-label="Key" defaultValue="Authorization" /><Input aria-label="Value" defaultValue="ghp_…" /></Stack> },
    },
  ],
  content: ["Keys in UPPER_SNAKE for env, header names as written; placeholders show the expected form."],
  accessibility: ["Every input and select is labelled with the group title; delete buttons name the row."],
  tokens: ["--space-sm", "--control-height-md", "--line"],
};
