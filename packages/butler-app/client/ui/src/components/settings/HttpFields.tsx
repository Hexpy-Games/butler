import { appCopy } from "@/app/copy.ts";
import { Field, FieldDescription, FieldLabel, Input } from "@/butler-ds";
import type { McpServerFormState } from "./mcpSettingsUtils";
import { McpSecretRows } from "./McpSecretRows";

export function HttpFields({
  form,
  onChange,
}: {
  form: McpServerFormState;
  onChange: (patch: Partial<McpServerFormState>) => void;
}) {
  const copy = appCopy.settings;
  return (
    <>
      <Field>
        <FieldLabel htmlFor="mcp-http-url">{copy.fields.mcpUrl}</FieldLabel>
        <Input
          id="mcp-http-url"
          value={form.url}
          onChange={(event) => onChange({ url: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel>{copy.fields.mcpHeaders}</FieldLabel>
        <FieldDescription>{copy.descriptions.mcpSecrets}</FieldDescription>
        <McpSecretRows
          title={copy.fields.mcpHeaders}
          addLabel="헤더 추가"
          rows={form.headerRows}
          onRowsChange={(headerRows) =>
            onChange({ headerRows, headersDirty: true })
          }
        />
      </Field>
    </>
  );
}
