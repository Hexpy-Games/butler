import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import {
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Textarea,
} from "@/butler-ds";
import type { McpServerFormState } from "./mcpSettingsUtils";
import { McpSecretRows } from "./McpSecretRows";

export function StdioFields({
  form,
  onChange,
}: {
  form: McpServerFormState;
  onChange: (patch: Partial<McpServerFormState>) => void;
}) {
  useAppLocale();
  const copy = appCopy.settings;
  return (
    <>
      <Field>
        <FieldLabel htmlFor="mcp-stdio-command">{copy.fields.mcpCommand}</FieldLabel>
        <Input
          id="mcp-stdio-command"
          value={form.command}
          onChange={(event) => onChange({ command: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="mcp-stdio-args">{copy.fields.mcpArgs}</FieldLabel>
        <Textarea
          id="mcp-stdio-args"
          placeholder={copy.placeholders.mcpArgs}
          value={form.argsText}
          onChange={(event) => onChange({ argsText: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="mcp-stdio-cwd">{copy.fields.mcpCwd}</FieldLabel>
        <Input
          id="mcp-stdio-cwd"
          value={form.cwd}
          onChange={(event) => onChange({ cwd: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel>{copy.fields.mcpEnv}</FieldLabel>
        <FieldDescription>{copy.descriptions.mcpSecrets}</FieldDescription>
        <McpSecretRows
          title={copy.fields.mcpEnv}
          addLabel={appCopy.interfaceDetails.addEnvironment}
          rows={form.envRows}
          onRowsChange={(envRows) => onChange({ envRows, envDirty: true })}
        />
      </Field>
    </>
  );
}
