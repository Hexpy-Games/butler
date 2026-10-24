import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { Input, SettingsField, Textarea } from "@/butler-ds";
import type { McpServerFormState } from "./mcpSettingsUtils";
import { McpSecretRows } from "./McpSecretRows";

export function StdioFields({
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
        id="mcp-stdio-command"
        label={copy.fields.mcpCommand}
        error={error}
        control={<Input
          id="mcp-stdio-command"
          value={form.command}
          onChange={(event) => onChange({ command: event.target.value })}
        />}
      />
      <SettingsField
        id="mcp-stdio-args"
        label={copy.fields.mcpArgs}
        control={<Textarea
          id="mcp-stdio-args"
          placeholder={copy.placeholders.mcpArgs}
          value={form.argsText}
          onChange={(event) => onChange({ argsText: event.target.value })}
        />}
      />
      <SettingsField
        id="mcp-stdio-cwd"
        label={copy.fields.mcpCwd}
        control={<Input
          id="mcp-stdio-cwd"
          value={form.cwd}
          onChange={(event) => onChange({ cwd: event.target.value })}
        />}
      />
      <SettingsField
        label={copy.fields.mcpEnv}
        description={copy.descriptions.mcpSecrets}
        controlWidth="full"
        control={<McpSecretRows
          title={copy.fields.mcpEnv}
          addLabel={appCopy.interfaceDetails.addEnvironment}
          rows={form.envRows}
          onRowsChange={(envRows) => onChange({ envRows, envDirty: true })}
        />}
      />
    </>
  );
}
