import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { Input, SettingsField } from "@/butler-ds";
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
      <SettingsField
        id="mcp-http-url"
        label={copy.fields.mcpUrl}
        error={error}
        control={<Input
          id="mcp-http-url"
          value={form.url}
          onChange={(event) => onChange({ url: event.target.value })}
        />}
      />
      <SettingsField
        label={copy.fields.mcpHeaders}
        description={copy.descriptions.mcpSecrets}
        controlWidth="full"
        control={<McpSecretRows
          title={copy.fields.mcpHeaders}
          addLabel={appCopy.interfaceDetails.addHeader}
          rows={form.headerRows}
          onRowsChange={(headerRows) =>
            onChange({ headerRows, headersDirty: true })
          }
        />}
      />
    </>
  );
}
