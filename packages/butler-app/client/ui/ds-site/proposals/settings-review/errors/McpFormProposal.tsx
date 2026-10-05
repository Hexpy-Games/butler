import { appCopy, useAppLocale } from "@/app/copy";
import type { McpTransportKind } from "@/app/types";
import {
  Button, ButtonContainer, Field, FieldDescription, FieldError, FieldLabel, Input, NativeSelect,
  NativeSelectOption, Stack, Switch, Textarea,
} from "@/butler-ds";
import { McpSecretRows } from "@/components/settings/McpSecretRows";
import type { McpServerFormState } from "@/components/settings/mcpSettingsUtils";

// PROPOSAL COPY of components/settings/McpServerForm.tsx + StdioFields + HttpFields. Every field,
// order and control is kept. Changed: each field that the agent can reject takes an error under
// its control (FieldError, aria-invalid, aria-describedby), mapped from the agent's error code;
// the first invalid field gets focus on save. Today only the ID field has one.

export type McpFormErrors = Partial<Record<"id" | "command" | "url", string>>;

function TextField({ id, label, value, error, hint, onChange }: {
  id: string; label: string; value: string; error?: string; hint?: string; onChange: (value: string) => void;
}) {
  const hintId = `${id}-hint`;
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} value={value} aria-invalid={Boolean(error)} aria-describedby={error || hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value)} />
      {error ? <FieldError id={hintId}>{error}</FieldError> : hint ? <FieldDescription id={hintId}>{hint}</FieldDescription> : null}
    </Field>
  );
}

export function McpFormProposal({ form, errors, onChange, onSave }: {
  form: McpServerFormState; errors: McpFormErrors;
  onChange: (patch: Partial<McpServerFormState>) => void; onSave: () => void;
}) {
  useAppLocale();
  const copy = appCopy.settings;
  return (
    <Stack gap="sm">
      <TextField id="mcp-server-id" label={copy.fields.mcpServerId} value={form.id} error={errors.id}
        hint={copy.mcpIdPreview(form.id.toLowerCase().replace(/^-+|-+$/gu, ""))} onChange={(id) => onChange({ id })} />
      <TextField id="mcp-server-name" label={copy.fields.mcpServerName} value={form.displayName}
        onChange={(displayName) => onChange({ displayName })} />
      <Field>
        <FieldLabel htmlFor="mcp-transport">{copy.fields.mcpTransport}</FieldLabel>
        <NativeSelect id="mcp-transport" value={form.transport}
          onChange={(event) => onChange({ transport: event.target.value as McpTransportKind })}>
          <NativeSelectOption value="stdio">{copy.options.stdio}</NativeSelectOption>
          <NativeSelectOption value="http">{copy.options.http}</NativeSelectOption>
          <NativeSelectOption value="sse">{copy.options.sse}</NativeSelectOption>
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor="mcp-enabled">{copy.fields.enabled}</FieldLabel>
        <Switch id="mcp-enabled" checked={form.enabled} onCheckedChange={(enabled) => onChange({ enabled })} />
      </Field>
      {form.transport === "stdio" ? (
        <>
          <TextField id="mcp-stdio-command" label={copy.fields.mcpCommand} value={form.command} error={errors.command}
            onChange={(command) => onChange({ command })} />
          <Field>
            <FieldLabel htmlFor="mcp-stdio-args">{copy.fields.mcpArgs}</FieldLabel>
            <Textarea id="mcp-stdio-args" placeholder={copy.placeholders.mcpArgs} value={form.argsText}
              onChange={(event) => onChange({ argsText: event.target.value })} />
          </Field>
          <TextField id="mcp-stdio-cwd" label={copy.fields.mcpCwd} value={form.cwd} onChange={(cwd) => onChange({ cwd })} />
          <Field>
            <FieldLabel>{copy.fields.mcpEnv}</FieldLabel>
            <FieldDescription>{copy.descriptions.mcpSecrets}</FieldDescription>
            <McpSecretRows title={copy.fields.mcpEnv} addLabel={appCopy.interfaceDetails.addEnvironment}
              rows={form.envRows} onRowsChange={(envRows) => onChange({ envRows, envDirty: true })} />
          </Field>
        </>
      ) : (
        <>
          <TextField id="mcp-http-url" label={copy.fields.mcpUrl} value={form.url} error={errors.url}
            onChange={(url) => onChange({ url })} />
          <Field>
            <FieldLabel>{copy.fields.mcpHeaders}</FieldLabel>
            <FieldDescription>{copy.descriptions.mcpSecrets}</FieldDescription>
            <McpSecretRows title={copy.fields.mcpHeaders} addLabel={appCopy.interfaceDetails.addHeader}
              rows={form.headerRows} onRowsChange={(headerRows) => onChange({ headerRows, headersDirty: true })} />
          </Field>
        </>
      )}
      <ButtonContainer size="default" justify="end">
        <Button type="button" variant="outline">{appCopy.common.cancel}</Button>
        <Button type="button" disabled={Boolean(errors.id)} onClick={onSave}>{appCopy.common.save}</Button>
      </ButtonContainer>
    </Stack>
  );
}
