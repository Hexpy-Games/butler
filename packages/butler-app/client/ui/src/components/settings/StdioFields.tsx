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
  const copy = appCopy.settings;
  return (
    <>
      <Field>
        <FieldLabel>{copy.fields.mcpCommand}</FieldLabel>
        <Input
          value={form.command}
          onChange={(event) => onChange({ command: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel>{copy.fields.mcpArgs}</FieldLabel>
        <Textarea
          placeholder={copy.placeholders.mcpArgs}
          value={form.argsText}
          onChange={(event) => onChange({ argsText: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel>{copy.fields.mcpCwd}</FieldLabel>
        <Input
          value={form.cwd}
          onChange={(event) => onChange({ cwd: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel>{copy.fields.mcpEnv}</FieldLabel>
        <FieldDescription>{copy.descriptions.mcpSecrets}</FieldDescription>
        <McpSecretRows
          title={copy.fields.mcpEnv}
          addLabel="환경 변수 추가"
          rows={form.envRows}
          onRowsChange={(envRows) => onChange({ envRows, envDirty: true })}
        />
      </Field>
    </>
  );
}
