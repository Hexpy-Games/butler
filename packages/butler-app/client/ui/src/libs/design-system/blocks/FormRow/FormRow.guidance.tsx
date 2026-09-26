import type { ShowcaseGuidance } from "../../showcase";
import { Input } from "../../components/Input";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { FormRow } from "./FormRow";

// #region recipe: Field with an inline error
function ApiKeyRow() {
  return (
    <FormRow htmlFor="api-key" label="API key" error="Keys start with sk-">
      <Input id="api-key" aria-invalid="true" defaultValue="pk-live-…" />
    </FormRow>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A label, control, help and error row for simple forms.",
  whenToUse: ["A compact form field that needs help or an error line"],
  whenNotToUse: [
    { when: "Settings pages", use: "SettingsField" },
    { when: "Composable field parts (legend, groups)", use: "Field" },
  ],
  recipes: [{ name: "Field with an inline error", description: "error replaces help and marks the row; set aria-invalid on the control.", render: () => <ApiKeyRow /> }],
  doDont: [
    {
      do: { caption: "The error sits next to the field it is about.", render: () => <ApiKeyRow /> },
      dont: { caption: "Errors collected at the top lose their field.", render: () => <Stack gap="xs"><Typo.Caption tone="danger">Keys start with sk-</Typo.Caption><Input aria-label="API key" /></Stack> },
    },
  ],
  content: ["Errors say how to fix it, not just what is wrong."],
  accessibility: ["htmlFor binds the label; the error is announced with the control."],
  tokens: ["--danger", "--text-secondary", "--space-xs"],
};
