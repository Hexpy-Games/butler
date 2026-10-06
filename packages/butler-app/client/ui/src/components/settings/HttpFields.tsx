import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { Field, FieldDescription, FieldError, FieldLabel, Input } from "@/butler-ds";
import type { McpServerFormState } from "./mcpSettingsUtils";
import { McpSecretRows } from "./McpSecretRows";

export function HttpFields({
  form,
  onChange,
  error,
}: {
  form: McpServerFormState;
  error?: string;
  onChange: (patch: Partial<McpServerFormState>) => void;
}) {
  useAppLocale();
  const copy = appCopy.settings;
  return (
    <>
      <Field data-invalid={Boolean(error)}>
        <FieldLabel htmlFor="mcp-http-url">{copy.fields.mcpUrl}</FieldLabel>
        <Input
          id="mcp-http-url"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "mcp-http-url-error" : undefined}
          value={form.url}
          onChange={(event) => onChange({ url: event.target.value })}
        />
        {error ? <FieldError id="mcp-http-url-error">{error}</FieldError> : null}
      </Field>
      <Field>
        <FieldLabel>{copy.fields.mcpHeaders}</FieldLabel>
        <FieldDescription>{copy.descriptions.mcpSecrets}</FieldDescription>
        <McpSecretRows
          title={copy.fields.mcpHeaders}
          addLabel={appCopy.interfaceDetails.addHeader}
          rows={form.headerRows}
          onRowsChange={(headerRows) =>
            onChange({ headerRows, headersDirty: true })
          }
        />
      </Field>
    </>
  );
}
